import { fail, ok } from "../../../../../../lib/api";
import { GoogleDriveError } from "../../../../../../lib/integrations/google-drive";
import {
  exportGeneratedImageToGoogleDrive,
  type GoogleDriveImportInput,
} from "../../../../../../lib/integrations/google-sync";
import { isOperatorRequest } from "../../../../../../lib/operator-auth";

const MAX_IMPORT_REQUEST_BYTES = 16 * 1024;

export async function POST(request: Request) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để lưu ảnh vào Google Drive.", 401);
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return fail("UNSUPPORTED_MEDIA_TYPE", "Yêu cầu lưu ảnh vào Drive phải dùng JSON.", 415);
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMPORT_REQUEST_BYTES) {
    return fail("REQUEST_TOO_LARGE", "Yêu cầu lưu ảnh vượt quá giới hạn cho phép.", 413);
  }

  try {
    const input = await request.json() as GoogleDriveImportInput;
    const actorId = request.headers.get("oai-authenticated-user-id");
    const result = await exportGeneratedImageToGoogleDrive(input, actorId);
    return ok(result, {
      status: result.alreadyUploaded ? 200 : 201,
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof SyntaxError) return fail("INVALID_JSON", "Dữ liệu JSON không hợp lệ.");
    if (error instanceof GoogleDriveError) return fail(error.code, error.userMessage, error.status, error.details);
    const code = error instanceof Error ? error.message : "GOOGLE_DRIVE_IMPORT_FAILED";
    if (code === "CONNECTION_NOT_FOUND") return fail("CONNECTION_NOT_FOUND", "Hãy kết nối lại tài khoản Google.", 409);
    if (code === "GOOGLE_REAUTH_REQUIRED") return fail(code, "Google yêu cầu kết nối lại tài khoản.", 401);
    console.error("GOOGLE_DRIVE_IMPORT_FAILED", error);
    return fail("GOOGLE_DRIVE_IMPORT_FAILED", "Không thể lưu ảnh vào Google Drive lúc này.", 502);
  }
}
