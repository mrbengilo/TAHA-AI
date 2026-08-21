import { fail, ok } from "../../../../../lib/api";
import { AutomationError, cancelAutomationRun } from "../../../../../lib/automation";
import { isOperatorRequest } from "../../../../../lib/operator-auth";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để hủy công việc AI.", 401);
  try {
    const { id } = await context.params;
    return ok({ run: await cancelAutomationRun(id) }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AutomationError) return fail(error.code, error.userMessage, error.status);
    return fail("AUTOMATION_CANCEL_FAILED", "Không thể hủy công việc AI.", 500);
  }
}
