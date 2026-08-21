import { fail, ok } from "../../../../lib/api";
import { AutomationError, getAutomationRun } from "../../../../lib/automation";
import { isViewerRequest } from "../../../../lib/operator-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isViewerRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để xem công việc AI.", 401);
  try {
    const { id } = await context.params;
    return ok({ run: await getAutomationRun(id) }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AutomationError) return fail(error.code, error.userMessage, error.status);
    return fail("AUTOMATION_LOAD_FAILED", "Không thể tải công việc AI.", 500);
  }
}
