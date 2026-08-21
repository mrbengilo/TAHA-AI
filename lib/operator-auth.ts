import { getRuntimeEnv } from "./integrations/env";

const MAX_COMPARISON_BYTES = 1024;

function constantTimeEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  if (a.length > MAX_COMPARISON_BYTES || b.length > MAX_COMPARISON_BYTES) difference |= 1;
  for (let index = 0; index < MAX_COMPARISON_BYTES; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function isLocalDevelopmentRequest(url: URL) {
  if (process.env.NODE_ENV === "production") return false;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function isAllowedValue(value: string | null, allowlistValue?: string, normalize = (input: string) => input) {
  if (!value || !allowlistValue) return false;
  const normalizedValue = normalize(value);
  const allowedIds = allowlistValue.split(",").map((value) => value.trim()).filter(Boolean);
  let matched = false;
  for (const allowedId of allowedIds) {
    matched = constantTimeEqual(normalizedValue, normalize(allowedId)) || matched;
  }
  return matched;
}

function isAllowedSitesUser(request: Request, userIds?: string, emails?: string) {
  const userIdAllowed = isAllowedValue(request.headers.get("oai-authenticated-user-id"), userIds);
  const emailAllowed = isAllowedValue(
    request.headers.get("oai-authenticated-user-email"),
    emails,
    (value) => value.trim().toLowerCase(),
  );
  return userIdAllowed || emailAllowed;
}

export function isOperatorRequest(request: Request) {
  const url = new URL(request.url);
  if (isLocalDevelopmentRequest(url)) return true;
  const runtime = getRuntimeEnv();
  const sitesUserAllowed = isAllowedSitesUser(
    request,
    runtime.SITES_OPERATOR_USER_IDS,
    runtime.SITES_OPERATOR_EMAILS,
  );
  const secret = runtime.INTERNAL_API_SECRET;
  const authorization = request.headers.get("authorization");
  const bearerAllowed = Boolean(secret && authorization?.startsWith("Bearer ") && constantTimeEqual(authorization.slice(7), secret));
  return sitesUserAllowed || bearerAllowed;
}

export function isViewerRequest(request: Request) {
  if (isOperatorRequest(request)) return true;
  const runtime = getRuntimeEnv();
  return isAllowedSitesUser(
    request,
    runtime.SITES_VIEWER_USER_IDS,
    runtime.SITES_VIEWER_EMAILS,
  );
}
