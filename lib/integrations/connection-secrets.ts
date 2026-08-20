import { decryptCredentials, encryptCredentials, hmacHex } from "./crypto";
import { getRuntimeEnv, requireEnv } from "./env";
import type { ProviderId } from "./providers";
import { TAHA_WORKSPACE_ID } from "./store";

export type StoredConnection<T extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  provider: ProviderId;
  displayName: string;
  externalAccountId: string | null;
  status: string;
  config: Record<string, unknown>;
  tokenExpiresAt: number | null;
  credentials: T;
};

export type RefreshableCredentials = Record<string, unknown> & {
  accessToken?: unknown;
  refreshToken?: unknown;
  refreshTokenExpireAt?: unknown;
};

const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const SHOPEE_ACCESS_TOKEN_SECONDS = 4 * 60 * 60;
const TIKTOK_ACCESS_TOKEN_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
type RefreshedToken = { accessToken: string; credentials: RefreshableCredentials; tokenExpiresAt: number };
const refreshInFlight = new Map<string, Promise<RefreshedToken>>();

function database() {
  const value = getRuntimeEnv().DB;
  if (!value) throw new Error("DATABASE_UNAVAILABLE");
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asNonEmptyString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : "";
}

function positiveSafeInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function durationExpiry(value: unknown, fallbackSeconds: number, now = Date.now()) {
  const seconds = Number(value);
  return now + (Number.isFinite(seconds) && seconds > 0 ? Math.max(seconds, 60) : fallbackSeconds) * 1000;
}

function unixTimestampExpiry(value: unknown, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
}

function hasUsableAccessToken(connection: StoredConnection<RefreshableCredentials>) {
  const accessToken = asNonEmptyString(connection.credentials.accessToken);
  return accessToken && connection.tokenExpiresAt !== null && connection.tokenExpiresAt > Date.now() + ACCESS_TOKEN_REFRESH_WINDOW_MS
    ? accessToken
    : "";
}

async function safeJson(response: Response) {
  try {
    return asObject(await response.json());
  } catch {
    return {};
  }
}

async function tokenFetch(input: URL | string, init: RequestInit, errorCode: string) {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS) });
  } catch {
    throw new Error(errorCode);
  }
}

async function persistRefreshedCredentials(
  connection: StoredConnection<RefreshableCredentials>,
  credentials: RefreshableCredentials,
  tokenExpiresAt: number,
  errorCode: string,
) {
  const encrypted = await encryptCredentials(credentials);
  const now = Date.now();
  const result = await database().prepare(
    `UPDATE channel_connections SET auth_ciphertext = ?, auth_iv = ?, auth_key_version = ?,
     token_expires_at = ?, last_verified_at = ?, updated_at = ?, last_error = NULL
     WHERE id = ? AND workspace_id = ? AND provider = ? AND status = 'connected'`,
  ).bind(
    encrypted.ciphertext,
    encrypted.iv,
    encrypted.keyVersion,
    tokenExpiresAt,
    now,
    now,
    connection.id,
    TAHA_WORKSPACE_ID,
    connection.provider,
  ).run();
  if (!result.success || result.meta.changes !== 1) throw new Error(errorCode);
}

function refreshOnce(connection: StoredConnection<RefreshableCredentials>, refresh: () => Promise<RefreshedToken>) {
  const key = `${connection.provider}:${connection.id}`;
  let request = refreshInFlight.get(key);
  if (!request) {
    request = refresh().finally(() => {
      if (refreshInFlight.get(key) === request) refreshInFlight.delete(key);
    });
    refreshInFlight.set(key, request);
  }
  return request.then((result) => {
    connection.credentials = { ...result.credentials };
    connection.tokenExpiresAt = result.tokenExpiresAt;
    return result.accessToken;
  });
}

export async function getConnectedIntegration<T extends Record<string, unknown>>(provider: ProviderId, connectionId?: string) {
  const query = connectionId
    ? `SELECT id, provider, display_name, external_account_id, status, config_json, token_expires_at, auth_ciphertext, auth_iv
       FROM channel_connections WHERE workspace_id = ? AND provider = ? AND id = ? AND status = 'connected' LIMIT 1`
    : `SELECT id, provider, display_name, external_account_id, status, config_json, token_expires_at, auth_ciphertext, auth_iv
       FROM channel_connections WHERE workspace_id = ? AND provider = ? AND status = 'connected' ORDER BY created_at ASC LIMIT 1`;
  const row = connectionId
    ? await database().prepare(query).bind(TAHA_WORKSPACE_ID, provider, connectionId).first<Record<string, unknown>>()
    : await database().prepare(query).bind(TAHA_WORKSPACE_ID, provider).first<Record<string, unknown>>();
  if (!row) throw new Error("CONNECTION_NOT_FOUND");
  if (!row.auth_ciphertext || !row.auth_iv) throw new Error("CONNECTION_CREDENTIALS_MISSING");
  return {
    id: String(row.id),
    provider: row.provider as ProviderId,
    displayName: String(row.display_name),
    externalAccountId: row.external_account_id ? String(row.external_account_id) : null,
    status: String(row.status),
    config: JSON.parse(String(row.config_json || "{}")) as Record<string, unknown>,
    tokenExpiresAt: typeof row.token_expires_at === "number" ? row.token_expires_at : null,
    credentials: await decryptCredentials<T>(String(row.auth_ciphertext), String(row.auth_iv)),
  } satisfies StoredConnection<T>;
}

export async function getGoogleAccessToken(connection: StoredConnection<{ accessToken?: unknown; refreshToken?: unknown }>) {
  const current = typeof connection.credentials.accessToken === "string" ? connection.credentials.accessToken : "";
  if (current && connection.tokenExpiresAt && connection.tokenExpiresAt > Date.now() + 2 * 60 * 1000) return current;
  const refreshToken = typeof connection.credentials.refreshToken === "string" ? connection.credentials.refreshToken : "";
  if (!refreshToken) throw new Error("GOOGLE_REAUTH_REQUIRED");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) throw new Error("GOOGLE_REAUTH_REQUIRED");
  const tokens = await response.json() as Record<string, unknown>;
  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : "";
  if (!accessToken) throw new Error("GOOGLE_REAUTH_REQUIRED");
  const tokenExpiresAt = Date.now() + Math.max(Number(tokens.expires_in) || 3600, 60) * 1000;
  const credentials = { ...connection.credentials, accessToken, refreshToken };
  const encrypted = await encryptCredentials(credentials);
  await database().prepare(
    `UPDATE channel_connections SET auth_ciphertext = ?, auth_iv = ?, auth_key_version = ?,
     token_expires_at = ?, last_verified_at = ?, updated_at = ?, last_error = NULL WHERE id = ?`,
  ).bind(encrypted.ciphertext, encrypted.iv, encrypted.keyVersion, tokenExpiresAt, Date.now(), Date.now(), connection.id).run();
  connection.credentials = credentials;
  connection.tokenExpiresAt = tokenExpiresAt;
  return accessToken;
}

export async function getShopeeAccessToken(connection: StoredConnection<RefreshableCredentials>) {
  if (connection.provider !== "shopee") throw new Error("CONNECTION_PROVIDER_MISMATCH");
  const current = hasUsableAccessToken(connection);
  if (current) return current;
  return refreshOnce(connection, async () => {
    const refreshToken = asNonEmptyString(connection.credentials.refreshToken);
    if (!refreshToken) throw new Error("SHOPEE_REAUTH_REQUIRED");
    const partnerId = positiveSafeInteger(requireEnv("SHOPEE_PARTNER_ID"));
    const shopId = positiveSafeInteger(connection.config.shopId ?? connection.externalAccountId);
    if (!partnerId || !shopId) throw new Error("SHOPEE_CONFIGURATION_INVALID");

    const path = "/api/v2/auth/access_token/get";
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = await hmacHex(requireEnv("SHOPEE_PARTNER_KEY"), `${partnerId}${path}${timestamp}`);
    const url = new URL(path, requireEnv("SHOPEE_BASE_URL"));
    url.searchParams.set("partner_id", String(partnerId));
    url.searchParams.set("timestamp", String(timestamp));
    url.searchParams.set("sign", sign);
    const response = await tokenFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken, partner_id: partnerId, shop_id: shopId }),
    }, "SHOPEE_TOKEN_REFRESH_FAILED");
    if (!response.ok) throw new Error("SHOPEE_TOKEN_REFRESH_FAILED");
    const root = await safeJson(response);
    if (asNonEmptyString(root.error)) throw new Error("SHOPEE_TOKEN_REFRESH_FAILED");
    const nested = asObject(root.response);
    const tokenData = Object.keys(nested).length > 0 ? nested : root;
    const accessToken = asNonEmptyString(tokenData.access_token);
    const nextRefreshToken = asNonEmptyString(tokenData.refresh_token);
    if (!accessToken || !nextRefreshToken) throw new Error("SHOPEE_REAUTH_REQUIRED");
    const tokenExpiresAt = durationExpiry(tokenData.expire_in, SHOPEE_ACCESS_TOKEN_SECONDS);
    const credentials = { ...connection.credentials, accessToken, refreshToken: nextRefreshToken };
    await persistRefreshedCredentials(connection, credentials, tokenExpiresAt, "SHOPEE_TOKEN_STORAGE_FAILED");
    return { accessToken, credentials, tokenExpiresAt };
  });
}

export async function getTikTokShopAccessToken(connection: StoredConnection<RefreshableCredentials>) {
  if (connection.provider !== "tiktok_shop") throw new Error("CONNECTION_PROVIDER_MISMATCH");
  const current = hasUsableAccessToken(connection);
  if (current) return current;
  return refreshOnce(connection, async () => {
    const refreshToken = asNonEmptyString(connection.credentials.refreshToken);
    if (!refreshToken) throw new Error("TIKTOK_SHOP_REAUTH_REQUIRED");
    const refreshTokenExpiresAt = unixTimestampExpiry(connection.credentials.refreshTokenExpireAt, Number.POSITIVE_INFINITY);
    if (refreshTokenExpiresAt <= Date.now() + ACCESS_TOKEN_REFRESH_WINDOW_MS) throw new Error("TIKTOK_SHOP_REAUTH_REQUIRED");

    const authBase = getRuntimeEnv().TIKTOK_SHOP_AUTH_BASE_URL || "https://auth.tiktok-shops.com";
    const url = new URL("/api/v2/token/refresh", authBase);
    url.searchParams.set("app_key", requireEnv("TIKTOK_SHOP_APP_KEY"));
    url.searchParams.set("app_secret", requireEnv("TIKTOK_SHOP_APP_SECRET"));
    url.searchParams.set("refresh_token", refreshToken);
    url.searchParams.set("grant_type", "refresh_token");
    const response = await tokenFetch(url, { method: "GET" }, "TIKTOK_SHOP_TOKEN_REFRESH_FAILED");
    if (!response.ok) throw new Error("TIKTOK_SHOP_TOKEN_REFRESH_FAILED");
    const root = await safeJson(response);
    if (root.code !== undefined && Number(root.code) !== 0) throw new Error("TIKTOK_SHOP_TOKEN_REFRESH_FAILED");
    const nested = asObject(root.data);
    const tokenData = Object.keys(nested).length > 0 ? nested : root;
    const accessToken = asNonEmptyString(tokenData.access_token);
    const nextRefreshToken = asNonEmptyString(tokenData.refresh_token);
    if (!accessToken || !nextRefreshToken) throw new Error("TIKTOK_SHOP_REAUTH_REQUIRED");
    const now = Date.now();
    const tokenExpiresAt = unixTimestampExpiry(tokenData.access_token_expire_in, now + TIKTOK_ACCESS_TOKEN_MS);
    const nextRefreshTokenExpiresAt = unixTimestampExpiry(tokenData.refresh_token_expire_in, refreshTokenExpiresAt);
    const credentials: RefreshableCredentials = {
      ...connection.credentials,
      accessToken,
      refreshToken: nextRefreshToken,
    };
    if (Number.isFinite(nextRefreshTokenExpiresAt)) credentials.refreshTokenExpireAt = nextRefreshTokenExpiresAt;
    await persistRefreshedCredentials(connection, credentials, tokenExpiresAt, "TIKTOK_SHOP_TOKEN_STORAGE_FAILED");
    return { accessToken, credentials, tokenExpiresAt };
  });
}
