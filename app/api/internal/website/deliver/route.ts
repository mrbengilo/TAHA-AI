import { fail, ok } from "../../../../../lib/api";
import { getRuntimeEnv } from "../../../../../lib/integrations/env";
import { deliverWebsiteAutomationRun, WebsiteDeliveryError } from "../../../../../lib/website-delivery";

export const dynamic = "force-dynamic";

async function constantTimeEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)), crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftHash), b = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

export async function POST(request: Request) {
  const secret = getRuntimeEnv().INTERNAL_API_SECRET;
  if (!secret) return fail("WEBSITE_DELIVERY_NOT_CONFIGURED", "Chưa cấu hình tác vụ đăng website.", 503);
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!provided || !(await constantTimeEqual(provided, secret))) return fail("UNAUTHORIZED", "Yêu cầu không hợp lệ.", 401);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return fail("UNSUPPORTED_MEDIA_TYPE", "Yêu cầu phải dùng JSON.", 415);
  }
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 4096) return fail("WEBSITE_DELIVERY_RUN_INVALID", "Công việc website không hợp lệ.", 400);
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { return fail("WEBSITE_DELIVERY_RUN_INVALID", "Công việc website không hợp lệ.", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== 1 || !("runId" in body) || typeof body.runId !== "string") {
    return fail("WEBSITE_DELIVERY_RUN_INVALID", "Chỉ được chọn một công việc website.", 400);
  }
  try {
    return ok(await deliverWebsiteAutomationRun(body.runId), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof WebsiteDeliveryError) return fail(error.code, "Chưa thể đăng công việc website này; cần kiểm tra trạng thái.", error.status);
    return fail("WEBSITE_DELIVERY_FAILED", "Không thể hoàn tất đăng website; kiểm tra trạng thái trước khi thử lại.", 500);
  }
}
