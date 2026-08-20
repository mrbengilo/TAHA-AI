import { fail, ok } from "../../../lib/api";
import { isOperatorRequest } from "../../../lib/operator-auth";
import { createSchedule, listSchedules, scheduleErrorResponse } from "../../../lib/schedules";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để xem lịch đăng.", 401);
  const query = new URL(request.url).searchParams;
  try {
    return ok({ schedules: await listSchedules(query.get("status"), query.get("limit")) });
  } catch (error) {
    const response = scheduleErrorResponse(error);
    return fail(response.code, response.message, response.status);
  }
}

export async function POST(request: Request) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để tạo lịch đăng.", 401);
  const body = await request.json().catch(() => null);
  try {
    const result = await createSchedule(body, request.headers.get("oai-authenticated-user-id"));
    return ok(result, { status: result.replay ? 200 : 201 });
  } catch (error) {
    const response = scheduleErrorResponse(error);
    return fail(response.code, response.message, response.status);
  }
}
