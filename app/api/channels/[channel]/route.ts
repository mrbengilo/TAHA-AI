import { fail, ok } from "../../../../lib/api";
import {
  ChannelLibraryError,
  getChannelLibrary,
  normalizeListLimit,
  requireChannelId,
} from "../../../../lib/channel-library";
import { isOperatorRequest } from "../../../../lib/operator-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ channel: string }> }) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để xem kho nội dung.", 401);
  try {
    const { channel } = await context.params;
    const channelId = requireChannelId(channel);
    const limit = normalizeListLimit(new URL(request.url).searchParams.get("limit"));
    return ok(await getChannelLibrary(channelId, limit), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ChannelLibraryError) return fail(error.code, error.message, error.status);
    console.error("CHANNEL_LIBRARY_LOAD_FAILED", error);
    return fail("CHANNEL_LIBRARY_LOAD_FAILED", "Không thể tải kho nội dung của kênh lúc này.", 500);
  }
}
