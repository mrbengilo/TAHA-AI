import { encryptCredentials, hmacHex } from "./crypto";
import { getRuntimeEnv, requireEnv } from "./env";
import { providerDefinitions, type ProviderId } from "./providers";
import { upsertConnection } from "./store";

type JsonObject = Record<string, unknown>;

export class ExternalIntegrationError extends Error {
  constructor(public readonly provider: ProviderId, public readonly status: number, message: string) {
    super(message);
    this.name = "ExternalIntegrationError";
  }
}

async function responseJson(response: Response, provider: ProviderId): Promise<JsonObject> {
  let data: JsonObject = {};
  try {
    data = await response.json() as JsonObject;
  } catch {
    // Do not expose an upstream response body that might include credential material.
  }
  if (!response.ok) throw new ExternalIntegrationError(provider, response.status, `Nền tảng từ chối yêu cầu (${response.status}).`);
  return data;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" ? value as JsonObject : {};
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function expiryFromSeconds(value: unknown, fallbackSeconds: number) {
  const numeric = Number(value);
  return Date.now() + (Number.isFinite(numeric) && numeric > 0 ? numeric : fallbackSeconds) * 1000;
}

function expiryFromTikTok(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Date.now() + 7 * 24 * 60 * 60 * 1000;
  if (numeric > 10_000_000_000) return numeric;
  if (numeric > 1_000_000_000) return numeric * 1000;
  return Date.now() + numeric * 1000;
}

export async function buildAuthorizationUrl(provider: Exclude<ProviderId, "zalo_personal" | "website">, state: string) {
  const runtime = getRuntimeEnv();

  if (provider === "google") {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", requireEnv("GOOGLE_CLIENT_ID"));
    url.searchParams.set("redirect_uri", requireEnv("GOOGLE_REDIRECT_URI"));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set(
      "scope",
      runtime.GOOGLE_OAUTH_SCOPES?.trim()
        || "openid email profile https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets.readonly",
    );
    url.searchParams.set("state", state);
    return url.toString();
  }

  if (provider === "facebook") {
    const version = requireEnv("META_GRAPH_API_VERSION");
    const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
    url.searchParams.set("client_id", requireEnv("META_APP_ID"));
    url.searchParams.set("redirect_uri", requireEnv("META_REDIRECT_URI"));
    url.searchParams.set("config_id", requireEnv("META_LOGIN_CONFIG_ID"));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("override_default_response_type", "true");
    url.searchParams.set("state", state);
    return url.toString();
  }

  if (provider === "shopee") {
    const path = "/api/v2/shop/auth_partner";
    const partnerId = requireEnv("SHOPEE_PARTNER_ID");
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = await hmacHex(requireEnv("SHOPEE_PARTNER_KEY"), `${partnerId}${path}${timestamp}`);
    const url = new URL(path, requireEnv("SHOPEE_BASE_URL"));
    url.searchParams.set("partner_id", partnerId);
    url.searchParams.set("timestamp", String(timestamp));
    url.searchParams.set("sign", sign);
    const redirect = new URL(requireEnv("SHOPEE_REDIRECT_URI"));
    redirect.searchParams.set("state", state);
    url.searchParams.set("redirect", redirect.toString());
    return url.toString();
  }

  const url = new URL(runtime.TIKTOK_SHOP_AUTHORIZE_URL || "https://services.tiktokshop.com/open/authorize");
  url.searchParams.set("service_id", requireEnv("TIKTOK_SHOP_SERVICE_ID"));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function connectGoogle(code: string) {
  const body = new URLSearchParams({
    code,
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
    redirect_uri: requireEnv("GOOGLE_REDIRECT_URI"),
    grant_type: "authorization_code",
  });
  const tokens = await responseJson(await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  }), "google");
  const accessToken = asString(tokens.access_token);
  if (!accessToken) throw new ExternalIntegrationError("google", 502, "Google không trả về access token.");

  let profile: JsonObject = {};
  try {
    const profileResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (profileResponse.ok) profile = asObject(await profileResponse.json());
  } catch {
    // Profile data only labels the connection; Drive access remains usable without it.
  }
  const encrypted = await encryptCredentials({
    accessToken,
    refreshToken: asString(tokens.refresh_token),
    tokenType: asString(tokens.token_type) || "Bearer",
  });
  const runtime = getRuntimeEnv();
  await upsertConnection({
    provider: "google",
    role: "source",
    displayName: asString(profile.email) || asString(profile.name) || "Google Drive",
    externalAccountId: asString(profile.id) || asString(profile.email) || "google-source",
    publishMode: "export_only",
    scopes: asString(tokens.scope).split(" ").filter(Boolean),
    capabilities: providerDefinitions.google.capabilities,
    config: {
      folderId: runtime.GOOGLE_DRIVE_FOLDER_ID ?? null,
      sheetId: runtime.GOOGLE_SHEET_ID ?? null,
      sheetName: runtime.GOOGLE_SHEET_NAME ?? "Products",
      sheetRange: runtime.GOOGLE_SHEET_RANGE ?? "Products!A:Z",
    },
    authCiphertext: encrypted.ciphertext,
    authIv: encrypted.iv,
    authKeyVersion: encrypted.keyVersion,
    tokenExpiresAt: expiryFromSeconds(tokens.expires_in, 3600),
  });
}

async function getLongLivedFacebookToken(shortToken: string) {
  const url = new URL(`https://graph.facebook.com/${requireEnv("META_GRAPH_API_VERSION")}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", requireEnv("META_APP_ID"));
  url.searchParams.set("client_secret", requireEnv("META_APP_SECRET"));
  url.searchParams.set("fb_exchange_token", shortToken);
  try {
    const data = await responseJson(await fetch(url), "facebook");
    return asString(data.access_token) || shortToken;
  } catch {
    return shortToken;
  }
}

export async function connectFacebook(code: string) {
  const version = requireEnv("META_GRAPH_API_VERSION");
  const tokenUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
  tokenUrl.searchParams.set("client_id", requireEnv("META_APP_ID"));
  tokenUrl.searchParams.set("client_secret", requireEnv("META_APP_SECRET"));
  tokenUrl.searchParams.set("redirect_uri", requireEnv("META_REDIRECT_URI"));
  tokenUrl.searchParams.set("code", code);
  const tokenData = await responseJson(await fetch(tokenUrl), "facebook");
  const shortToken = asString(tokenData.access_token);
  if (!shortToken) throw new ExternalIntegrationError("facebook", 502, "Meta không trả về access token.");
  const userToken = await getLongLivedFacebookToken(shortToken);

  const pagesUrl = new URL(`https://graph.facebook.com/${version}/me/accounts`);
  pagesUrl.searchParams.set("fields", "id,name,access_token,tasks");
  pagesUrl.searchParams.set("access_token", userToken);
  const pagesData = await responseJson(await fetch(pagesUrl), "facebook");
  const pages = Array.isArray(pagesData.data) ? pagesData.data.map(asObject) : [];
  if (pages.length === 0) throw new ExternalIntegrationError("facebook", 403, "Không tìm thấy Facebook Page có quyền tạo nội dung.");

  let saved = 0;
  for (const page of pages) {
    const tasks = Array.isArray(page.tasks) ? page.tasks.map(String) : [];
    const pageToken = asString(page.access_token);
    const canCreateContent = tasks.includes("CREATE_CONTENT") || tasks.includes("PROFILE_PLUS_CREATE_CONTENT");
    if (!pageToken || !asString(page.id) || !canCreateContent) continue;
    const encrypted = await encryptCredentials({ accessToken: pageToken, tokenType: "Bearer" });
    await upsertConnection({
      provider: "facebook",
      role: "publisher",
      displayName: asString(page.name) || "Facebook Page",
      externalAccountId: asString(page.id),
      publishMode: "api",
      scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
      capabilities: providerDefinitions.facebook.capabilities,
      config: { tasks },
      authCiphertext: encrypted.ciphertext,
      authIv: encrypted.iv,
      authKeyVersion: encrypted.keyVersion,
      tokenExpiresAt: null,
    });
    saved += 1;
  }
  if (saved === 0) throw new ExternalIntegrationError("facebook", 403, "Facebook Page không cấp token đăng bài.");
}

export async function connectShopee(code: string, shopId: string) {
  const path = "/api/v2/auth/token/get";
  const partnerId = requireEnv("SHOPEE_PARTNER_ID");
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = await hmacHex(requireEnv("SHOPEE_PARTNER_KEY"), `${partnerId}${path}${timestamp}`);
  const url = new URL(path, requireEnv("SHOPEE_BASE_URL"));
  url.searchParams.set("partner_id", partnerId);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  const response = await responseJson(await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, shop_id: Number(shopId), partner_id: Number(partnerId) }),
  }), "shopee");
  const tokenData = Object.keys(asObject(response.response)).length ? asObject(response.response) : response;
  const accessToken = asString(tokenData.access_token);
  if (!accessToken) throw new ExternalIntegrationError("shopee", 502, "Shopee không trả về access token.");
  const encrypted = await encryptCredentials({
    accessToken,
    refreshToken: asString(tokenData.refresh_token),
  });
  await upsertConnection({
    provider: "shopee",
    role: "commerce",
    displayName: `Shopee Shop ${shopId}`,
    externalAccountId: shopId,
    publishMode: "api",
    scopes: ["shop", "product", "media_space"],
    capabilities: providerDefinitions.shopee.capabilities,
    config: { shopId, region: getRuntimeEnv().SHOPEE_REGION ?? "VN" },
    authCiphertext: encrypted.ciphertext,
    authIv: encrypted.iv,
    authKeyVersion: encrypted.keyVersion,
    tokenExpiresAt: expiryFromSeconds(tokenData.expire_in, 4 * 60 * 60),
  });
}

async function getAuthorizedTikTokShops(accessToken: string) {
  const path = "/authorization/202309/shops";
  const appKey = requireEnv("TIKTOK_SHOP_APP_KEY");
  const appSecret = requireEnv("TIKTOK_SHOP_APP_SECRET");
  const timestamp = Math.floor(Date.now() / 1000);
  const signatureInput = `${appSecret}${path}app_key${appKey}timestamp${timestamp}${appSecret}`;
  const sign = await hmacHex(appSecret, signatureInput);
  const apiBase = getRuntimeEnv().TIKTOK_SHOP_API_BASE_URL || "https://open-api.tiktokglobalshop.com";
  const url = new URL(path, apiBase);
  url.searchParams.set("app_key", appKey);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  const response = await responseJson(await fetch(url, {
    headers: { "content-type": "application/json", "x-tts-access-token": accessToken },
  }), "tiktok_shop");
  const shops = asObject(response.data).shops;
  return Array.isArray(shops) ? shops.map(asObject) : [];
}

export async function connectTikTokShop(code: string) {
  const authBase = getRuntimeEnv().TIKTOK_SHOP_AUTH_BASE_URL || "https://auth.tiktok-shops.com";
  const url = new URL("/api/v2/token/get", authBase);
  url.searchParams.set("app_key", requireEnv("TIKTOK_SHOP_APP_KEY"));
  url.searchParams.set("app_secret", requireEnv("TIKTOK_SHOP_APP_SECRET"));
  url.searchParams.set("auth_code", code);
  url.searchParams.set("grant_type", "authorized_code");
  const response = await responseJson(await fetch(url), "tiktok_shop");
  const tokenData = Object.keys(asObject(response.data)).length ? asObject(response.data) : response;
  const accessToken = asString(tokenData.access_token);
  if (!accessToken) throw new ExternalIntegrationError("tiktok_shop", 502, "TikTok Shop không trả về access token.");
  const encrypted = await encryptCredentials({
    accessToken,
    refreshToken: asString(tokenData.refresh_token),
    refreshTokenExpireAt: tokenData.refresh_token_expire_in ?? null,
  });
  const shops = await getAuthorizedTikTokShops(accessToken);
  if (shops.length === 0) throw new ExternalIntegrationError("tiktok_shop", 403, "Không tìm thấy TikTok Shop đã cấp quyền.");
  let saved = 0;
  for (const shop of shops) {
    const shopCipher = asString(shop.cipher);
    const externalId = asString(shop.id) || asString(shop.code) || shopCipher;
    if (!shopCipher || !externalId) continue;
    await upsertConnection({
      provider: "tiktok_shop",
      role: "commerce",
      displayName: asString(shop.name) || "TikTok Shop",
      externalAccountId: externalId,
      publishMode: "api",
      scopes: ["seller.authorization.info", "seller.product.basic", "seller.product.write"],
      capabilities: providerDefinitions.tiktok_shop.capabilities,
      config: {
        market: asString(shop.region) || getRuntimeEnv().TIKTOK_SHOP_MARKET || "VN",
        shopCipher,
        shopCode: asString(shop.code) || null,
        sellerType: asString(shop.seller_type) || null,
      },
      authCiphertext: encrypted.ciphertext,
      authIv: encrypted.iv,
      authKeyVersion: encrypted.keyVersion,
      tokenExpiresAt: expiryFromTikTok(tokenData.access_token_expire_in),
    });
    saved += 1;
  }
  if (saved === 0) throw new ExternalIntegrationError("tiktok_shop", 502, "TikTok Shop không trả về shop cipher hợp lệ.");
}

export async function connectAssistedZalo() {
  return upsertConnection({
    provider: "zalo_personal",
    role: "publisher",
    displayName: "Zalo cá nhân · Hỗ trợ đăng",
    externalAccountId: "manual-assist",
    publishMode: "assisted",
    scopes: [],
    capabilities: providerDefinitions.zalo_personal.capabilities,
    config: { mode: "manual_assist", officialPublishingApi: false },
  });
}

export async function connectWebsite() {
  const baseUrl = requireEnv("WEBSITE_BASE_URL");
  const encrypted = await encryptCredentials({ webhookSecret: requireEnv("WEBSITE_WEBHOOK_SECRET") });
  return upsertConnection({
    provider: "website",
    role: "both",
    displayName: new URL(baseUrl).hostname,
    externalAccountId: new URL(baseUrl).origin,
    publishMode: "api",
    scopes: ["products:write", "content:write", "inventory:write"],
    capabilities: providerDefinitions.website.capabilities,
    config: { baseUrl, publishEndpoint: requireEnv("WEBSITE_PUBLISH_ENDPOINT") },
    authCiphertext: encrypted.ciphertext,
    authIv: encrypted.iv,
    authKeyVersion: encrypted.keyVersion,
  });
}
