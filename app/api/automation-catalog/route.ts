import { fail, ok } from "../../../lib/api";
import { AutomationError } from "../../../lib/automation";
import { prepareCatalogPage } from "../../../lib/catalog-preparation";
import { isOperatorRequest } from "../../../lib/operator-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Chỉ admin được chuẩn bị nội dung hàng loạt.", 401);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return fail("UNSUPPORTED_MEDIA_TYPE", "Yêu cầu phải dùng JSON.", 415);
  }
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).length > 4096) return fail("REQUEST_TOO_LARGE", "Yêu cầu vượt quá giới hạn.", 413);
    const input = JSON.parse(body);
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("INVALID_CATALOG_PAGE", "Dữ liệu không hợp lệ.");
    return ok(await prepareCatalogPage(input, request.headers.get("oai-authenticated-user-id") || "catalog-preparation"), {
      status: 202, headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof SyntaxError) return fail("INVALID_JSON", "Dữ liệu JSON không hợp lệ.");
    if (error instanceof AutomationError) return fail(error.code, error.userMessage, error.status);
    return fail("CATALOG_PREPARATION_FAILED", "Không thể chuẩn bị danh sách SKU lúc này.", 500);
  }
}
