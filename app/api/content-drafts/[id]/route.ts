import { fail, ok } from "../../../../lib/api";
import { ContentReviewError, reviewContentDraft } from "../../../../lib/content-review";
import { isOperatorRequest } from "../../../../lib/operator-auth";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Chỉ admin được sửa hoặc chặn bài viết.", 401);
  try {
    const text = await request.text();
    if (text.length > 20000) return fail("REQUEST_TOO_LARGE", "Nội dung vượt giới hạn.", 413);
    const input = JSON.parse(text);
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("INVALID_REQUEST", "Dữ liệu không hợp lệ.", 422);
    const { id } = await context.params;
    return ok(await reviewContentDraft(id, input, request.headers.get("oai-authenticated-user-id") || "operator"));
  } catch (error) {
    if (error instanceof SyntaxError) return fail("INVALID_JSON", "Dữ liệu không hợp lệ.", 422);
    if (error instanceof ContentReviewError) return fail(error.code, error.userMessage, error.status);
    return fail("REVIEW_FAILED", "Không thể cập nhật bài viết.", 500);
  }
}
