import { fail, ok } from "../../../../lib/api";
import { FacebookPublishingPlanError } from "../../../../lib/facebook-publishing-plans";
import { listFacebookRepostProducts, scheduleFacebookRepost } from "../../../../lib/facebook-reposts";
import { isOperatorRequest } from "../../../../lib/operator-auth";
import { ScheduleError } from "../../../../lib/schedules";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  if (error instanceof FacebookPublishingPlanError) {
    return fail(error.code, error.userMessage, error.status);
  }
  if (error instanceof ScheduleError) return fail(error.code, error.message, error.status);
  return fail("FACEBOOK_REPOST_FAILED", "Không thể lên lịch đăng lại Facebook lúc này.", 500);
}

export async function GET(request: Request) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần quyền admin để đăng lại Facebook.", 401);
  try {
    return ok(await listFacebookRepostProducts(), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần quyền admin để đăng lại Facebook.", 401);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return fail("UNSUPPORTED_MEDIA_TYPE", "Yêu cầu phải dùng JSON.", 415);
  }
  const body = await request.json().catch(() => null);
  try {
    const result = await scheduleFacebookRepost(body, request.headers.get("oai-authenticated-user-id"));
    return ok(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
