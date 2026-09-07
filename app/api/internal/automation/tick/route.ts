import { fail, ok } from "../../../../../lib/api";
import { runAutomationWorker } from "../../../../../lib/automation";
import { getRuntimeEnv } from "../../../../../lib/integrations/env";

export const dynamic = "force-dynamic";

async function constantTimeEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

export async function POST(request: Request) {
  const secret = getRuntimeEnv().INTERNAL_API_SECRET;
  if (!secret) return fail("AUTOMATION_WORKER_NOT_CONFIGURED", "Worker AI chưa được cấu hình.", 503);
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!provided || !(await constantTimeEqual(provided, secret))) {
    return fail("UNAUTHORIZED", "Yêu cầu worker AI không hợp lệ.", 401);
  }
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 4_096) {
    return fail("AUTOMATION_RUN_FILTER_INVALID", "Danh sách công việc AI không hợp lệ.", 400);
  }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { return fail("AUTOMATION_RUN_FILTER_INVALID", "Danh sách công việc AI không hợp lệ.", 400); }
  const runIds = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { runIds?: unknown }).runIds
    : undefined;
  if (!Array.isArray(runIds) || runIds.length < 1 || runIds.length > 50
    || runIds.some((id) => typeof id !== "string")) {
    return fail("AUTOMATION_RUN_FILTER_INVALID", "Danh sách công việc AI không hợp lệ.", 400);
  }
  try {
    return ok({ automation: await runAutomationWorker({ limit: 1, runIds }) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "AUTOMATION_WORKER_TICK_FAILED";
    if (code === "DATABASE_UNAVAILABLE") return fail(code, "Cơ sở dữ liệu worker chưa sẵn sàng.", 503);
    if (code === "AUTOMATION_RUN_FILTER_INVALID") return fail(code, "Danh sách công việc AI không hợp lệ.", 400);
    return fail("AUTOMATION_WORKER_TICK_FAILED", "Không thể xử lý bước AI lúc này.", 500);
  }
}
