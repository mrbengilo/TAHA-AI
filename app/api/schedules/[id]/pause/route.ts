import { fail, ok } from "../../../../../lib/api";
import { isOperatorRequest } from "../../../../../lib/operator-auth";
import { pauseSchedule, scheduleErrorResponse } from "../../../../../lib/schedules";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để tạm dừng lịch.", 401);
  const { id } = await context.params;
  try {
    return ok(await pauseSchedule(id));
  } catch (error) {
    const response = scheduleErrorResponse(error);
    return fail(response.code, response.message, response.status);
  }
}
