import { fail, ok } from "../../../lib/api";
import {
  AutomationError,
  listAutomationRuns,
  queueAutomationRun,
  type QueueAutomationInput,
} from "../../../lib/automation";
import { isOperatorRequest, isViewerRequest } from "../../../lib/operator-auth";

export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 32 * 1024;

export async function GET(request: Request) {
  if (!isViewerRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để xem công việc AI.", 401);
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 20);
  try {
    return ok({ runs: await listAutomationRuns(limit) }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AutomationError) return fail(error.code, error.userMessage, error.status);
    return fail("AUTOMATION_LIST_FAILED", "Không thể tải danh sách công việc AI.", 500);
  }
}

export async function POST(request: Request) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để chạy AI.", 401);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return fail("UNSUPPORTED_MEDIA_TYPE", "Yêu cầu phải dùng JSON.", 415);
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return fail("REQUEST_TOO_LARGE", "Yêu cầu AI vượt quá giới hạn cho phép.", 413);
  }
  try {
    const input = await request.json() as QueueAutomationInput;
    const result = await queueAutomationRun(input, request.headers.get("oai-authenticated-user-id"));
    return ok(result, {
      status: result.replayed ? 200 : 202,
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof SyntaxError) return fail("INVALID_JSON", "Dữ liệu JSON không hợp lệ.");
    if (error instanceof AutomationError) return fail(error.code, error.userMessage, error.status);
    return fail("AUTOMATION_QUEUE_FAILED", "Không thể tạo công việc AI lúc này.", 500);
  }
}
