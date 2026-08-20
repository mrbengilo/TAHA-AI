import { fail, ok } from "../../../../../lib/api";
import { isOperatorRequest } from "../../../../../lib/operator-auth";
import { confirmAssistedJob } from "../../../../../lib/publish-jobs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để xác nhận bài đăng.", 401);
  const body = await request.json().catch(() => null) as null | { result?: unknown; externalUrl?: unknown };
  if (!body || (body.result !== "published" && body.result !== "failed")) return fail("INVALID_RESULT", "Kết quả xác nhận không hợp lệ.", 422);
  const { id } = await context.params;
  const externalUrl = typeof body.externalUrl === "string" && body.externalUrl.startsWith("https://") ? body.externalUrl : null;
  try {
    await confirmAssistedJob(id, body.result, externalUrl, request.headers.get("oai-authenticated-user-id"));
    return ok({ id, status: body.result });
  } catch {
    return fail("JOB_NOT_AWAITING_CONFIRMATION", "Bài này không còn chờ xác nhận.", 409);
  }
}
