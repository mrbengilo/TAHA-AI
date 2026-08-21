import { fail, ok } from "../../../../../lib/api";
import {
  ChannelLibraryError,
  createChannelDraft,
  requireChannelId,
  type CreateDraftInput,
} from "../../../../../lib/channel-library";
import { isOperatorRequest } from "../../../../../lib/operator-auth";

const MAX_DRAFT_REQUEST_BYTES = 64 * 1024;

export async function POST(request: Request, context: { params: Promise<{ channel: string }> }) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để tạo bài viết.", 401);
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return fail("UNSUPPORTED_MEDIA_TYPE", "Yêu cầu tạo bài viết phải dùng JSON.", 415);
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_DRAFT_REQUEST_BYTES) {
    return fail("REQUEST_TOO_LARGE", "Dữ liệu bài viết vượt quá giới hạn cho phép.", 413);
  }
  try {
    const { channel } = await context.params;
    const channelId = requireChannelId(channel);
    const input = await request.json() as CreateDraftInput;
    const actorId = request.headers.get("oai-authenticated-user-id");
    return ok(
      { draft: await createChannelDraft(channelId, input, actorId) },
      { status: 201, headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof SyntaxError) return fail("INVALID_JSON", "Dữ liệu JSON không hợp lệ.");
    if (error instanceof ChannelLibraryError) return fail(error.code, error.message, error.status);
    console.error("CHANNEL_DRAFT_CREATE_FAILED", error);
    return fail("CHANNEL_DRAFT_CREATE_FAILED", "Không thể lưu bài viết lúc này.", 500);
  }
}
