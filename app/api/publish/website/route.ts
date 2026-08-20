import { fail, ok } from "../../../../lib/api";
import { isOperatorRequest } from "../../../../lib/operator-auth";
import { publishWebsite } from "../../../../lib/publishing";

export async function POST(request: Request) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để đăng nội dung.", 401);
  const body = await request.json().catch(() => null) as null | { connectionId?: unknown; payload?: unknown; idempotencyKey?: unknown };
  if (!body || typeof body.connectionId !== "string" || !body.payload || typeof body.payload !== "object" || typeof body.idempotencyKey !== "string") {
    return fail("INVALID_REQUEST", "Thiếu website, nội dung hoặc mã chống đăng trùng.", 422);
  }
  try {
    return ok(await publishWebsite({ connectionId: body.connectionId, payload: body.payload as Record<string, unknown>, idempotencyKey: body.idempotencyKey }));
  } catch (error) {
    const code = error instanceof Error ? error.message : "WEBSITE_PUBLISH_FAILED";
    if (code === "IDEMPOTENCY_KEY_IN_USE") return fail(code, "Công việc này đã được gửi trước đó và đang chờ đối soát.", 409);
    if (code === "CONNECTION_NOT_FOUND" || code === "WEBSITE_REAUTH_REQUIRED") return fail(code, "Website chưa kết nối hoặc cấu hình đã thay đổi.", 409);
    return fail("WEBSITE_PUBLISH_FAILED", "Website chưa nhận được nội dung. Hệ thống đã lưu lỗi để kiểm tra.", 502);
  }
}
