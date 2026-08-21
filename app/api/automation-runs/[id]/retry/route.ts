import { fail, ok } from "../../../../../lib/api";
import { AutomationError, retryAutomationRun } from "../../../../../lib/automation";
import { isOperatorRequest } from "../../../../../lib/operator-auth";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để thử lại công việc AI.", 401);
  try {
    const { id } = await context.params;
    return ok({ run: await retryAutomationRun(id) }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AutomationError) return fail(error.code, error.userMessage, error.status);
    return fail("AUTOMATION_RETRY_FAILED", "Không thể thử lại công việc AI.", 500);
  }
}
