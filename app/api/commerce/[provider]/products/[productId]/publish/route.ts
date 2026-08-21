import { fail, ok } from "../../../../../../../lib/api";
import { CommercePublishError, queueCommerceProductPublish } from "../../../../../../../lib/commerce-publish";
import { isOperatorRequest } from "../../../../../../../lib/operator-auth";

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string; productId: string }> },
) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để đăng sản phẩm.", 401);
  try {
    const { provider, productId } = await context.params;
    const body = request.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      ? await request.json() as { connectionId?: unknown }
      : {};
    const connectionId = typeof body.connectionId === "string" ? body.connectionId : null;
    return ok(await queueCommerceProductPublish(provider, productId, connectionId), {
      status: 202,
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof SyntaxError) return fail("INVALID_JSON", "Dữ liệu JSON không hợp lệ.");
    if (error instanceof CommercePublishError) return fail(error.code, error.userMessage, error.status, error.details);
    return fail("COMMERCE_QUEUE_FAILED", "Không thể tạo công việc đăng sản phẩm.", 500);
  }
}
