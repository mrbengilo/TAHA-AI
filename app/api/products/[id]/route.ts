import { fail, ok } from "../../../../lib/api";
import { isOperatorRequest, isViewerRequest } from "../../../../lib/operator-auth";
import { getProductFolder } from "../../../../lib/product-folder";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isViewerRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để xem sản phẩm.", 401);
  try {
    const { id } = await context.params;
    return ok({ ...await getProductFolder(id), canReview: isOperatorRequest(request) }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message === "PRODUCT_NOT_FOUND") return fail("PRODUCT_NOT_FOUND", "Không tìm thấy sản phẩm.", 404);
    return fail("PRODUCT_LOAD_FAILED", "Không thể tải thư mục sản phẩm.", 503);
  }
}
