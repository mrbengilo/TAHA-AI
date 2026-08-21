import { fail, ok } from "../../../../../lib/api";
import {
  ChannelLibraryError,
  MAX_UPLOAD_REQUEST_BYTES,
  requireChannelId,
  uploadChannelMedia,
} from "../../../../../lib/channel-library";
import { isOperatorRequest } from "../../../../../lib/operator-auth";

function formText(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

export async function POST(request: Request, context: { params: Promise<{ channel: string }> }) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để tải tệp lên.", 401);
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return fail("UNSUPPORTED_MEDIA_TYPE", "Yêu cầu tải tệp phải dùng biểu mẫu multipart.", 415);
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_REQUEST_BYTES) {
    return fail("REQUEST_TOO_LARGE", "Yêu cầu tải tệp vượt quá giới hạn cho phép.", 413);
  }
  try {
    const { channel } = await context.params;
    const channelId = requireChannelId(channel);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return fail("FILE_REQUIRED", "Hãy chọn ảnh hoặc video để tải lên.");
    const actorId = request.headers.get("oai-authenticated-user-id");
    return ok(
      {
        media: await uploadChannelMedia(channelId, {
          file,
          altText: formText(form, "altText"),
          productId: formText(form, "productId"),
          draftId: formText(form, "draftId"),
        }, actorId),
      },
      { status: 201, headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof ChannelLibraryError) return fail(error.code, error.message, error.status);
    console.error("CHANNEL_MEDIA_UPLOAD_FAILED", error);
    return fail("CHANNEL_MEDIA_UPLOAD_FAILED", "Không thể lưu tệp lúc này.", 500);
  }
}
