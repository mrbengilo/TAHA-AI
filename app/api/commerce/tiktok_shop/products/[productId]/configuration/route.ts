import { fail, ok } from "../../../../../../../lib/api";
import {
  CommercePublishError,
  saveTikTokListingConfiguration,
  type TikTokListingConfigurationInput,
} from "../../../../../../../lib/commerce-publish";
import { isOperatorRequest } from "../../../../../../../lib/operator-auth";

export async function PUT(
  request: Request,
  context: { params: Promise<{ productId: string }> },
) {
  if (!isOperatorRequest(request)) {
    return fail("UNAUTHORIZED", "Bạn cần đăng nhập để cấu hình listing TikTok.", 401);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return fail("UNSUPPORTED_MEDIA_TYPE", "Yêu cầu phải dùng JSON.", 415);
  }
  try {
    const { productId } = await context.params;
    const input = await request.json() as TikTokListingConfigurationInput;
    return ok(await saveTikTokListingConfiguration(productId, input), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof SyntaxError) return fail("INVALID_JSON", "Dữ liệu JSON không hợp lệ.");
    if (error instanceof CommercePublishError) {
      return fail(error.code, error.userMessage, error.status, error.details);
    }
    return fail("TIKTOK_CONFIG_SAVE_FAILED", "Không thể lưu cấu hình TikTok Shop.", 500);
  }
}
