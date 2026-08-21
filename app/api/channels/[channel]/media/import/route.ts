import { fail, ok } from "../../../../../../lib/api";
import {
  ChannelLibraryError,
  importChannelMedia,
  requireChannelId,
  type MediaImportInput,
} from "../../../../../../lib/channel-library";
import { isOperatorRequest } from "../../../../../../lib/operator-auth";

const MAX_IMPORT_REQUEST_BYTES = 32 * 1024;

export async function POST(request: Request, context: { params: Promise<{ channel: string }> }) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để dùng ảnh nguồn.", 401);
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return fail("UNSUPPORTED_MEDIA_TYPE", "Yêu cầu dùng lại media phải dùng JSON.", 415);
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMPORT_REQUEST_BYTES) {
    return fail("REQUEST_TOO_LARGE", "Danh sách media vượt quá giới hạn cho phép.", 413);
  }

  try {
    const { channel } = await context.params;
    const channelId = requireChannelId(channel);
    const input = await request.json() as MediaImportInput;
    const actorId = request.headers.get("oai-authenticated-user-id");
    return ok(
      await importChannelMedia(channelId, input, actorId),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof SyntaxError) return fail("INVALID_JSON", "Dữ liệu JSON không hợp lệ.");
    if (error instanceof ChannelLibraryError) return fail(error.code, error.message, error.status);
    console.error("CHANNEL_MEDIA_IMPORT_FAILED", error);
    return fail("CHANNEL_MEDIA_IMPORT_FAILED", "Không thể dùng lại media nguồn lúc này.", 500);
  }
}
