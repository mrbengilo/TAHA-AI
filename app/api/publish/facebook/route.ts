import { fail, ok } from "../../../../lib/api";
import { ContentReviewError, scheduleReviewedDraft } from "../../../../lib/content-review";
import { isOperatorRequest } from "../../../../lib/operator-auth";

export async function POST(request: Request) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để đăng bài.", 401);
  const body = await request.json().catch(() => null) as null | { connectionId?: unknown; draftId?: unknown; payload?: { draftId?: unknown } };
  const draftId = body?.draftId ?? body?.payload?.draftId;
  if (typeof body?.connectionId !== "string" || typeof draftId !== "string") return fail("DRAFT_REQUIRED", "Chọn bài viết đã xác nhận trong thư mục SKU để đăng đúng ảnh và nội dung.", 422);
  try {
    return ok(await scheduleReviewedDraft(draftId, body.connectionId, "facebook"), { status: 202 });
  } catch (error) {
    if (error instanceof ContentReviewError) return fail(error.code, error.userMessage, error.status);
    return fail("PRODUCT_CONTENT_MISMATCH", "Ảnh, SKU hoặc thông tin sản phẩm không còn khớp. Hãy đồng bộ và kiểm tra lại thư mục SKU.", 409);
  }
}
