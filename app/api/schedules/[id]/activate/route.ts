import { fail, ok } from "../../../../../lib/api";
import { isOperatorRequest } from "../../../../../lib/operator-auth";
import { activateSchedule, scheduleErrorResponse } from "../../../../../lib/schedules";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để kích hoạt lịch.", 401);
  const { id } = await context.params;
  try {
    return ok(await activateSchedule(id));
  } catch (error) {
    const response = scheduleErrorResponse(error);
    return fail(response.code, response.message, response.status);
  }
}
