export function ok<T>(data: T, init?: ResponseInit) {
  return Response.json({ data }, { status: 200, ...init });
}

export function fail(code: string, message: string, status = 400, details?: unknown) {
  return Response.json(
    {
      error: { code, message, ...(details === undefined ? {} : { details }) },
      requestId: crypto.randomUUID(),
    },
    { status },
  );
}

export function redirectWithResult(
  request: Request,
  provider: string,
  result: "connected" | "error",
  message?: string,
) {
  const requestUrl = new URL(request.url);
  const configuredOrigin = getRuntimeEnv().PUBLIC_APP_URL?.trim();
  const isLocalDevelopment = process.env.NODE_ENV !== "production"
    && (requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1" || requestUrl.hostname === "[::1]");
  if (!configuredOrigin && !isLocalDevelopment) {
    return fail("PUBLIC_ORIGIN_MISSING", "Máy chủ chưa cấu hình địa chỉ ứng dụng công khai.", 500);
  }
  let base: URL;
  try {
    base = new URL(configuredOrigin || requestUrl.origin);
  } catch {
    return fail("PUBLIC_ORIGIN_INVALID", "Địa chỉ ứng dụng công khai không hợp lệ.", 500);
  }
  if (base.protocol !== "https:" && !isLocalDevelopment) {
    return fail("PUBLIC_ORIGIN_INVALID", "Địa chỉ ứng dụng công khai phải dùng HTTPS.", 500);
  }
  const url = new URL("/connections", base);
  url.searchParams.set("provider", provider);
  url.searchParams.set("result", result);
  if (message) url.searchParams.set("message", message.slice(0, 180));
  return Response.redirect(url, 303);
}
import { getRuntimeEnv } from "./integrations/env";
