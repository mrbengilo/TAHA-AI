import { fail, ok } from "../../../lib/api";
import { ChannelLibraryError, listChannelSummaries } from "../../../lib/channel-library";
import { isViewerRequest } from "../../../lib/operator-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isViewerRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để xem kho nội dung.", 401);
  try {
    return ok({ channels: await listChannelSummaries() }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ChannelLibraryError) return fail(error.code, error.message, error.status);
    console.error("CHANNELS_LIST_FAILED", error);
    return fail("CHANNELS_LIST_FAILED", "Không thể tải danh sách kênh lúc này.", 500);
  }
}
