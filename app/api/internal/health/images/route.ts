import { fail, ok } from "../../../../../lib/api";
import { compressImageToJpeg, ORIGINAL_IMAGE_MAX_BYTES } from "../../../../../lib/image-compression";
import { isOperatorRequest } from "../../../../../lib/operator-auth";

export const dynamic = "force-dynamic";

// A fixed PNG exercises the real runtime decoder/encoder without touching
// customer media or calling any paid generation API.
const FIXTURE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=";

export async function POST(request: Request) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Yêu cầu không hợp lệ.", 401);
  try {
    const source = new Blob([Uint8Array.from(atob(FIXTURE), (c) => c.charCodeAt(0))], { type: "image/png" });
    const result = await compressImageToJpeg(source, ORIGINAL_IMAGE_MAX_BYTES);
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.length >= ORIGINAL_IMAGE_MAX_BYTES) throw new Error("IMAGE_PROBE_FAILED");
    return ok({ bytes: bytes.length, width: result.width, height: result.height, mimeType: result.mimeType }, {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return fail("IMAGE_TRANSFORM_UNAVAILABLE", "Bộ tối ưu ảnh chưa sẵn sàng.", 503);
  }
}
