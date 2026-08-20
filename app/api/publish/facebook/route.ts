import { fail, ok } from "../../../../lib/api";
import { isOperatorRequest } from "../../../../lib/operator-auth";
import { publishFacebook } from "../../../../lib/publishing";

export async function POST(request: Request) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để đăng bài.", 401);
  const body = await request.json().catch(() => null) as null | { connectionId?: unknown; message?: unknown; mediaIds?: unknown; idempotencyKey?: unknown };
  if (!body || typeof body.connectionId !== "string" || typeof body.message !== "string" || typeof body.idempotencyKey !== "string") {
    return fail("INVALID_REQUEST", "Thiếu kênh, nội dung hoặc mã chống đăng trùng.", 422);
  }
  if (!body.message.trim() || body.message.length > 60000) return fail("INVALID_MESSAGE", "Nội dung bài đăng không hợp lệ.", 422);
  const mediaIds = Array.isArray(body.mediaIds) ? body.mediaIds.filter((value): value is string => typeof value === "string").slice(0, 10) : [];
  try {
    return ok(await publishFacebook({ connectionId: body.connectionId, message: body.message, mediaIds, idempotencyKey: body.idempotencyKey }));
  } catch (error) {
    const code = error instanceof Error ? error.message : "FACEBOOK_PUBLISH_FAILED";
    if (code === "IDEMPOTENCY_KEY_IN_USE") return fail(code, "Công việc này đã được gửi trước đó và đang chờ đối soát.", 409);
    if (code === "CONNECTION_NOT_FOUND" || code === "FACEBOOK_REAUTH_REQUIRED") return fail(code, "Facebook Page chưa kết nối hoặc cần cấp quyền lại.", 409);
    return fail("FACEBOOK_PUBLISH_FAILED", "Facebook chưa nhận được bài đăng. Hệ thống đã lưu lỗi để kiểm tra.", 502);
  }
}
