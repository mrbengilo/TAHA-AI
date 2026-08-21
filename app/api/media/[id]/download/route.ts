import { fail } from "../../../../../lib/api";
import { isViewerRequest } from "../../../../../lib/operator-auth";
import { loadMedia } from "../../../../../lib/media";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isViewerRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để tải ảnh.", 401);
  try {
    const { id } = await context.params;
    const media = await loadMedia(id);
    return new Response(media.body, {
      headers: {
        "content-type": media.mimeType,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(media.filename)}`,
        "cache-control": "private, no-store",
        ...(media.size ? { "content-length": String(media.size) } : {}),
      },
    });
  } catch {
    return fail("MEDIA_NOT_FOUND", "Không tìm thấy ảnh hoặc tài khoản nguồn cần kết nối lại.", 404);
  }
}
