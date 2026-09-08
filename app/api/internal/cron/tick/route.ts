import { fail, ok } from "../../../../../lib/api";
import { runAutomationWorker } from "../../../../../lib/automation";
import { ensureDailyGoogleCatalogRefresh, ensureDailyProductAutomation } from "../../../../../lib/daily-automation";
import { runPublishDispatcher } from "../../../../../lib/dispatcher";
import { getRuntimeEnv } from "../../../../../lib/integrations/env";
import { runSchedulerTick } from "../../../../../lib/scheduler";
import { ensureWebsiteReadyBackfill } from "../../../../../lib/website-backfill";

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
  if (!secret) return fail("CRON_NOT_CONFIGURED", "Lịch chạy nền chưa được cấu hình trên máy chủ.", 503);
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!provided || !(await constantTimeEqual(provided, secret))) return fail("UNAUTHORIZED", "Yêu cầu lịch chạy nền không hợp lệ.", 401);

  try {
    // Deadlines first: enqueue and dispatch content that is already due before doing AI content work.
    const scheduler = await runSchedulerTick();
    const dispatcher = await runPublishDispatcher();

    let google: Awaited<ReturnType<typeof ensureDailyGoogleCatalogRefresh>> | { refreshed: false; reason: string };
    try {
      google = await ensureDailyGoogleCatalogRefresh();
    } catch {
      google = { refreshed: false, reason: "google_refresh_failed" };
    }

    // Run after the catalog refresh so newly discovered, website-ready products
    // can be made due immediately by the same idempotent scheduler flow.
    let website: Awaited<ReturnType<typeof ensureWebsiteReadyBackfill>> | { errorCode: string };
    try { website = await ensureWebsiteReadyBackfill(); }
    catch { website = { errorCode: "WEBSITE_READY_BACKFILL_FAILED" }; }
    let websiteDelivery: {
      scheduler: Awaited<ReturnType<typeof runSchedulerTick>>;
      dispatcher: Awaited<ReturnType<typeof runPublishDispatcher>>;
    } | { errorCode: string } | null = null;
    if ("queued" in website && website.queued > 0) {
      try {
        websiteDelivery = { scheduler: await runSchedulerTick(), dispatcher: await runPublishDispatcher() };
      } catch {
        websiteDelivery = { errorCode: "WEBSITE_DELIVERY_TICK_FAILED" };
      }
    }

    let daily: Awaited<ReturnType<typeof ensureDailyProductAutomation>> | { queued: false; reason: string };
    try {
      daily = await ensureDailyProductAutomation();
    } catch {
      daily = { queued: false, reason: "daily_planning_failed" };
    }

    let automation: Awaited<ReturnType<typeof runAutomationWorker>> | { errorCode: string };
    try {
      automation = await runAutomationWorker({ limit: 1 });
    } catch {
      automation = { errorCode: "AUTOMATION_TICK_FAILED" };
    }

    return ok({ google, website, websiteDelivery, daily, automation, scheduler, dispatcher }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "CRON_TICK_FAILED";
    if (code === "DATABASE_UNAVAILABLE") return fail(code, "Cơ sở dữ liệu lịch chạy nền chưa sẵn sàng.", 503);
    return fail("CRON_TICK_FAILED", "Không thể xử lý công việc nền lúc này.", 500);
  }
}
