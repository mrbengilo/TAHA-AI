import { fail, ok } from "../../../../../lib/api";
import {
  FacebookPermissionCheckError,
  verifyFacebookConnection,
} from "../../../../../lib/integrations/facebook-permissions";
import { isOperatorRequest } from "../../../../../lib/operator-auth";

const MAX_REQUEST_BYTES = 4 * 1024;

export async function POST(request: Request) {
  if (!isOperatorRequest(request)) {
    return fail("UNAUTHORIZED", "Bạn cần đăng nhập để kiểm tra kết nối Facebook.", 401);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return fail("UNSUPPORTED_MEDIA_TYPE", "Yêu cầu kiểm tra Facebook phải dùng JSON.", 415);
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return fail("REQUEST_TOO_LARGE", "Yêu cầu kiểm tra Facebook vượt quá giới hạn cho phép.", 413);
  }

  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
      return fail("REQUEST_TOO_LARGE", "Yêu cầu kiểm tra Facebook vượt quá giới hạn cho phép.", 413);
    }
    let body: unknown;
    try { body = JSON.parse(rawBody); } catch { return fail("INVALID_JSON", "Dữ liệu JSON không hợp lệ."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return fail("INVALID_JSON", "Dữ liệu JSON không hợp lệ.");
    }
    const connectionValue = (body as { connectionId?: unknown }).connectionId;
    const connectionId = typeof connectionValue === "string" ? connectionValue.trim() : "";
    if (!/^[A-Za-z0-9-]{1,128}$/.test(connectionId)) {
      return fail("INVALID_CONNECTION_ID", "Kết nối Facebook không hợp lệ.", 400);
    }
    return ok(await verifyFacebookConnection(connectionId), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof FacebookPermissionCheckError) {
      return fail(error.code, error.userMessage, error.status);
    }
    return fail("FACEBOOK_PERMISSION_VERIFY_FAILED", "Không thể kiểm tra kết nối Facebook lúc này.", 500);
  }
}
