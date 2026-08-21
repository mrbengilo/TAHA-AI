import { hmacHex } from "./crypto";
import { getRuntimeEnv, requireEnv } from "./env";

const REQUEST_TIMEOUT_MS = 20_000;
const SIGNATURE_EXCLUDED_QUERY_KEYS = new Set(["access_token", "sign"]);

export type TikTokShopQuery = Record<string, string | number | boolean | null | undefined>;

export type TikTokShopRequest = {
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  accessToken: string;
  query?: TikTokShopQuery;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
};

export class TikTokShopApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
    public readonly outcomeUnknown = false,
    public readonly requestId: string | null = null,
  ) {
    super(code);
    this.name = "TikTokShopApiError";
  }
}

function normalizedQuery(query: TikTokShopQuery) {
  return Object.fromEntries(Object.entries(query).flatMap(([key, value]) => (
    value === null || value === undefined ? [] : [[key, String(value)]]
  )));
}

/**
 * Builds the exact byte string TikTok Shop signs. JSON bodies must already be
 * serialized so the bytes sent over the network cannot differ from the bytes
 * included in the signature.
 */
export function canonicalTikTokShopSignatureInput(input: {
  appSecret: string;
  path: string;
  query: TikTokShopQuery;
  bodyText?: string;
  multipart?: boolean;
}) {
  if (!input.path.startsWith("/")) throw new Error("TIKTOK_SHOP_PATH_INVALID");
  const query = normalizedQuery(input.query);
  const queryText = Object.keys(query)
    .filter((key) => !SIGNATURE_EXCLUDED_QUERY_KEYS.has(key))
    .sort()
    .map((key) => `${key}${query[key]}`)
    .join("");
  const bodyText = !input.multipart && input.bodyText ? input.bodyText : "";
  return `${input.appSecret}${input.path}${queryText}${bodyText}${input.appSecret}`;
}

export async function signTikTokShopRequest(input: {
  appSecret: string;
  path: string;
  query: TikTokShopQuery;
  bodyText?: string;
  multipart?: boolean;
}) {
  return hmacHex(input.appSecret, canonicalTikTokShopSignatureInput(input));
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function responseRequestId(root: Record<string, unknown>) {
  return typeof root.request_id === "string" && root.request_id ? root.request_id : null;
}

function remoteErrorCode(root: Record<string, unknown>, status: number) {
  const code = Number(root.code);
  if (Number.isFinite(code) && code !== 0) return `TIKTOK_SHOP_API_${code}`;
  return `TIKTOK_SHOP_HTTP_${status}`;
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function responseJson(response: Response) {
  try {
    return asObject(await response.json());
  } catch {
    return {};
  }
}

export async function callTikTokShopJson(
  request: TikTokShopRequest,
  fetcher: typeof fetch = fetch,
) {
  const appKey = requireEnv("TIKTOK_SHOP_APP_KEY");
  const appSecret = requireEnv("TIKTOK_SHOP_APP_SECRET");
  const timestamp = Math.floor(Date.now() / 1000);
  const method = request.method ?? "GET";
  if (request.idempotencyKey !== undefined && (!request.idempotencyKey || request.idempotencyKey.length > 128)) {
    throw new TikTokShopApiError("TIKTOK_SHOP_IDEMPOTENCY_KEY_INVALID");
  }
  const body = request.idempotencyKey
    ? { ...(request.body ?? {}), idempotency_key: request.idempotencyKey }
    : request.body;
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  const query = normalizedQuery({
    ...request.query,
    app_key: appKey,
    timestamp,
  });
  query.sign = await signTikTokShopRequest({ appSecret, path: request.path, query, bodyText });

  const baseUrl = getRuntimeEnv().TIKTOK_SHOP_API_BASE_URL || "https://open-api.tiktokglobalshop.com";
  const url = new URL(request.path, baseUrl);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));

  let response: Response;
  try {
    response = await fetcher(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "x-tts-access-token": request.accessToken,
      },
      body: bodyText || undefined,
    });
  } catch {
    // Requests with an idempotency key can be retried safely. Other writes must
    // be reconciled before retrying because TikTok may have accepted them.
    const writeRequest = method !== "GET";
    const safeRetry = !writeRequest || Boolean(request.idempotencyKey);
    throw new TikTokShopApiError("TIKTOK_SHOP_NETWORK_ERROR", safeRetry, writeRequest && !safeRetry);
  }

  const root = await responseJson(response);
  const platformCode = Number(root.code);
  if (!response.ok || (Number.isFinite(platformCode) && platformCode !== 0)) {
    throw new TikTokShopApiError(
      remoteErrorCode(root, response.status),
      isRetryableStatus(response.status) || platformCode === 36009003,
      false,
      responseRequestId(root),
    );
  }
  return { data: asObject(root.data), requestId: responseRequestId(root) };
}

export async function uploadTikTokShopProductImage(input: {
  accessToken: string;
  blob: Blob;
  filename: string;
}, fetcher: typeof fetch = fetch) {
  const appKey = requireEnv("TIKTOK_SHOP_APP_KEY");
  const appSecret = requireEnv("TIKTOK_SHOP_APP_SECRET");
  const path = "/product/202309/images/upload";
  const timestamp = Math.floor(Date.now() / 1000);
  const query = { app_key: appKey, timestamp: String(timestamp) };
  const sign = await signTikTokShopRequest({ appSecret, path, query, multipart: true });
  const baseUrl = getRuntimeEnv().TIKTOK_SHOP_API_BASE_URL || "https://open-api.tiktokglobalshop.com";
  const url = new URL(path, baseUrl);
  url.searchParams.set("app_key", appKey);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  const form = new FormData();
  form.set("data", input.blob, input.filename);
  form.set("use_case", "MAIN_IMAGE");

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "x-tts-access-token": input.accessToken },
      body: form,
    });
  } catch {
    throw new TikTokShopApiError("TIKTOK_SHOP_IMAGE_NETWORK_ERROR", true);
  }
  const root = await responseJson(response);
  const data = asObject(root.data);
  const uri = typeof data.uri === "string" ? data.uri.trim() : "";
  const platformCode = Number(root.code);
  if (!response.ok || (Number.isFinite(platformCode) && platformCode !== 0) || !uri) {
    throw new TikTokShopApiError(
      uri ? remoteErrorCode(root, response.status) : "TIKTOK_SHOP_IMAGE_URI_MISSING",
      isRetryableStatus(response.status) || platformCode === 36009003,
      false,
      responseRequestId(root),
    );
  }
  return {
    uri,
    url: typeof data.url === "string" ? data.url.trim() : null,
    width: Number.isFinite(Number(data.width)) ? Number(data.width) : null,
    height: Number.isFinite(Number(data.height)) ? Number(data.height) : null,
    requestId: responseRequestId(root),
  };
}
