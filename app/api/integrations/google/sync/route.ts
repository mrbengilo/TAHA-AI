import { fail, ok } from "../../../../../lib/api";
import { GoogleDriveError } from "../../../../../lib/integrations/google-drive";
import { syncGoogleCatalog } from "../../../../../lib/integrations/google-sync";
import { isOperatorRequest } from "../../../../../lib/operator-auth";

export async function POST(request: Request) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để đồng bộ dữ liệu.", 401);
  const body = await request.json().catch(() => ({})) as { connectionId?: string };
  try {
    return ok(await syncGoogleCatalog(body.connectionId));
  } catch (error) {
    if (error instanceof GoogleDriveError) return fail(error.code, error.userMessage, error.status, error.details);
    const code = error instanceof Error ? error.message : "GOOGLE_SYNC_FAILED";
    if (code === "CONNECTION_NOT_FOUND") return fail(code, "Chưa có tài khoản Google đã kết nối.", 409);
    if (code === "GOOGLE_REAUTH_REQUIRED") return fail(code, "Google yêu cầu kết nối lại tài khoản.", 401);
    if (code === "GOOGLE_SOURCE_NOT_CONFIGURED") return fail(code, "Chưa chọn thư mục Drive hoặc Google Sheet nguồn.", 409);
    console.error("GOOGLE_SYNC_FAILED", error);
    return fail("GOOGLE_SYNC_FAILED", "Không thể đồng bộ Google Drive và Sheet lúc này.", 502);
  }
}
