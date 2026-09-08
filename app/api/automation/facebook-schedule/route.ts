import { fail, ok } from "../../../../lib/api";
import {
  FacebookPublishingPlanError,
  listFacebookPublishingPlans,
  saveFacebookPublishingPlan,
} from "../../../../lib/facebook-publishing-plans";
import { isOperatorRequest } from "../../../../lib/operator-auth";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  if (error instanceof FacebookPublishingPlanError) {
    return fail(error.code, error.userMessage, error.status);
  }
  return fail("FACEBOOK_PLAN_FAILED", "Không thể xử lý lịch đăng Facebook lúc này.", 500);
}

export async function GET(request: Request) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần quyền admin để xem lịch Facebook.", 401);
  try {
    return ok(await listFacebookPublishingPlans(), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần quyền admin để cài lịch Facebook.", 401);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return fail("UNSUPPORTED_MEDIA_TYPE", "Yêu cầu phải dùng JSON.", 415);
  }
  const body = await request.json().catch(() => null);
  try {
    return ok(await saveFacebookPublishingPlan(body));
  } catch (error) {
    return errorResponse(error);
  }
}

