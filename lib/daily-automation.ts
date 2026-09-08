import { queueAutomationRun } from "./automation";
import { parseFacebookPublishingPlans, vietnamTimestamp } from "./facebook-publishing-plans";
import { getRuntimeEnv } from "./integrations/env";
import { syncGoogleCatalog } from "./integrations/google-sync";
import { productSources } from "./product-integrity";
import { TAHA_WORKSPACE_ID } from "./integrations/store";

const DAY_MS = 24 * 60 * 60 * 1000;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const GOOGLE_REFRESH_RETRY_MS = 60 * 60 * 1000;
const FACEBOOK_PREPARATION_HORIZON_MS = 7 * DAY_MS;

type Statement = {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results?: T[] }>;
};

function db() {
  const value = getRuntimeEnv().DB as unknown as { prepare(query: string): Statement } | undefined;
  if (!value) throw new Error("DATABASE_UNAVAILABLE");
  return value;
}

function publicationDay(now: number) {
  const local = new Date(now + VN_OFFSET_MS);
  const afterPreparationWindow = local.getUTCHours() >= 6;
  const target = new Date(local.getTime() + (afterPreparationWindow ? DAY_MS : 0));
  const y = target.getUTCFullYear();
  const m = String(target.getUTCMonth() + 1).padStart(2, "0");
  const d = String(target.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function localDay(now: number) {
  const local = new Date(now + VN_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Refreshes the canonical Sheet and Drive catalog once per Vietnam calendar
 * day. Failed attempts are durably throttled so a minute cron cannot hammer
 * Google, while still allowing another attempt later the same day.
 */
export async function ensureDailyGoogleCatalogRefresh(now = Date.now()) {
  const database = db();
  const day = localDay(now);
  const google = await database.prepare(
    `SELECT id FROM channel_connections
     WHERE workspace_id = ? AND provider = 'google' AND status = 'connected'
     ORDER BY updated_at DESC LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID).first<{ id: string }>();
  if (!google) return { refreshed: false as const, day, reason: "google_not_connected" as const };

  const claimed = await database.prepare(
    `UPDATE channel_connections
     SET config_json = json_set(config_json,
       '$._dailyCatalogRefreshAttemptDay', ?,
       '$._dailyCatalogRefreshAttemptAt', ?)
     WHERE id = ? AND workspace_id = ? AND provider = 'google' AND status = 'connected'
       AND COALESCE(json_extract(config_json, '$._dailyCatalogRefreshSucceededDay'), '') != ?
       AND (COALESCE(json_extract(config_json, '$._dailyCatalogRefreshAttemptDay'), '') != ?
         OR COALESCE(json_extract(config_json, '$._dailyCatalogRefreshAttemptAt'), 0) <= ?)
     RETURNING id`,
  ).bind(day, now, google.id, TAHA_WORKSPACE_ID, day, day, now - GOOGLE_REFRESH_RETRY_MS).first<{ id: string }>();
  if (!claimed) {
    const state = await database.prepare(
      `SELECT json_extract(config_json, '$._dailyCatalogRefreshSucceededDay') AS succeeded_day
       FROM channel_connections WHERE id = ? AND workspace_id = ?`,
    ).bind(google.id, TAHA_WORKSPACE_ID).first<{ succeeded_day: string | null }>();
    return {
      refreshed: false as const,
      day,
      reason: state?.succeeded_day === day ? "already_refreshed" as const : "retry_deferred" as const,
    };
  }

  const sync = await syncGoogleCatalog(google.id);
  await database.prepare(
    `UPDATE channel_connections
     SET config_json = json_set(config_json,
       '$._dailyCatalogRefreshSucceededDay', ?,
       '$._dailyCatalogRefreshSucceededAt', ?)
     WHERE id = ? AND workspace_id = ? AND provider = 'google' AND status = 'connected'
     RETURNING id`,
  ).bind(day, now, google.id, TAHA_WORKSPACE_ID).first<{ id: string }>();
  return { refreshed: true as const, day, sync };
}

export async function ensureDailyProductAutomation(now = Date.now()) {
  const database = db();
  const connections = await database.prepare(
    `SELECT id, provider, config_json FROM channel_connections
     WHERE workspace_id = ? AND status = 'connected'
       AND provider = 'facebook' AND json_extract(config_json, '$.dailyAutomationEnabled') = 1`,
  ).bind(TAHA_WORKSPACE_ID).all<{ id: string; provider: string; config_json: string }>();
  const publishConnections = connections.results ?? [];
  const fallbackDay = publicationDay(now);
  if (!publishConnections.length) return { queued: false, day: fallbackDay, reason: "no_publish_channels" };
  if (publishConnections.length !== 1) return { queued: false, day: fallbackDay, reason: "ambiguous_publish_channels" };
  const facebookConnectionId = publishConnections[0].id;
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(publishConnections[0].config_json) as Record<string, unknown>; } catch { /* use default */ }
  const customPlans = parseFacebookPublishingPlans(config);
  const explicitDays = new Set(customPlans.map((plan) => plan.date));
  const slots = customPlans.flatMap((plan) => plan.times.map((time) => ({
    day: plan.date,
    time,
    scheduledFor: vietnamTimestamp(plan.date, time),
    custom: true,
    revision: plan.updatedAt,
  })));
  if (!explicitDays.has(fallbackDay)) {
    slots.push({ day: fallbackDay, time: "08:00", scheduledFor: vietnamTimestamp(fallbackDay, "08:00"), custom: false, revision: 0 });
  }
  const eligibleSlots = slots
    .filter((slot) => slot.scheduledFor > now && slot.scheduledFor <= now + FACEBOOK_PREPARATION_HORIZON_MS)
    .sort((left, right) => left.scheduledFor - right.scheduledFor);
  let target: (typeof eligibleSlots)[number] | null = null;
  let existingRunId: string | null = null;
  let existingScheduleId: string | null = null;
  for (const slot of eligibleSlots) {
    const scheduled = await database.prepare(
      `SELECT s.id FROM schedules s
       JOIN content_drafts d ON d.id = s.draft_id AND d.workspace_id = s.workspace_id
       WHERE s.workspace_id = ? AND s.connection_id = ? AND s.status IN ('active','completed')
         AND d.target_provider = 'facebook' AND s.run_at = ? LIMIT 1`,
    ).bind(TAHA_WORKSPACE_ID, facebookConnectionId, slot.scheduledFor).first<{ id: string }>();
    if (scheduled) { existingScheduleId = scheduled.id; continue; }
    const runs = await database.prepare(
      `SELECT id, request_key, status FROM automation_runs
       WHERE workspace_id = ? AND request_key LIKE ? ORDER BY created_at DESC`,
    ).bind(TAHA_WORKSPACE_ID, `daily:${slot.day}:%`).all<{ id: string; request_key: string; status: string }>();
    const planned = (runs.results ?? []).find((run) => {
      const parts = run.request_key.split(":");
      const matchesTime = parts.length === 3 ? slot.time === "08:00" : parts.length >= 4 && parts[2] === slot.time.replace(":", "");
      if (!matchesTime) return false;
      if (run.status === "completed") return false;
      return run.status !== "cancelled" || !slot.custom || parts[3] === String(slot.revision);
    });
    if (planned) { existingRunId = planned.id; continue; }
    target = slot;
    break;
  }
  if (!target) return existingScheduleId
    ? { queued: false, day: fallbackDay, reason: "already_scheduled", scheduleId: existingScheduleId }
    : { queued: false, day: fallbackDay, reason: "already_planned", ...(existingRunId ? { runId: existingRunId } : {}) };
  const day = target.day;

  const candidates = await database.prepare(
    `SELECT p.id, p.base_sku
     FROM products p
     WHERE p.workspace_id = ? AND p.deleted_at IS NULL AND p.status = 'active'
       AND (SELECT COUNT(DISTINCT m.id)
            FROM product_media pm JOIN media_assets m ON m.id = pm.media_id AND m.workspace_id = pm.workspace_id
            WHERE pm.workspace_id = p.workspace_id AND pm.product_id = p.id
              AND m.media_type = 'image' AND m.origin = 'source' AND m.status = 'ready') >= 1
       AND NOT EXISTS (
         SELECT 1 FROM automation_runs active
         WHERE active.workspace_id = p.workspace_id AND active.product_id = p.id
           AND active.status IN ('queued', 'processing')
       )
       AND NOT EXISTS (
         SELECT 1 FROM automation_runs planned
         WHERE planned.workspace_id = p.workspace_id AND planned.product_id = p.id
           AND planned.request_key LIKE ?
           AND (planned.status IN ('queued','processing') OR EXISTS (
             SELECT 1 FROM schedules planned_schedule
             WHERE planned_schedule.workspace_id=planned.workspace_id
               AND planned_schedule.created_by='automation:' || planned.id
               AND planned_schedule.status IN ('active','completed')
           ))
       )
     ORDER BY COALESCE((
       SELECT MAX(done.created_at) FROM automation_runs done
       WHERE done.workspace_id = p.workspace_id AND done.product_id = p.id AND done.status = 'completed'
     ), 0) ASC, p.updated_at ASC, p.base_sku ASC
     LIMIT 100`,
  ).bind(TAHA_WORKSPACE_ID, `daily:${day}:%`).all<{ id: string; base_sku: string }>();
  let product: { id: string; base_sku: string } | null = null;
  for (const candidate of candidates.results ?? []) {
    try { await productSources(candidate.id); product = candidate; break; }
    catch (error) { if (!(error instanceof Error) || !["PRODUCT_SOURCE_CHANGED", "PRODUCT_SKU_FOLDER_MISMATCH", "SKU_SOURCE_IMAGES_REQUIRED", "PRODUCT_NOT_ACTIVE"].includes(error.message)) throw error; }
  }
  if (!product) return { queued: false, day, reason: "no_ready_product" };

  const queued = await queueAutomationRun({
    productId: product.id,
    imageCount: 0,
    targetProviders: ["facebook"],
    connectionIds: { facebook: facebookConnectionId },
    ...(target.custom ? { scheduledFor: target.scheduledFor } : {}),
    idempotencyKey: `daily:${day}:${target.time.replace(":", "")}:${target.custom ? `${target.revision}:` : ""}${product.id}`,
  }, "daily-automation");
  return { queued: true, day, time: target.time, scheduledFor: target.scheduledFor, productId: product.id, sku: product.base_sku, run: queued.run };
}
