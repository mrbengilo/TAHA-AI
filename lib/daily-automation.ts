import { queueAutomationRun } from "./automation";
import { getRuntimeEnv } from "./integrations/env";
import { syncGoogleCatalog } from "./integrations/google-sync";
import { productSources } from "./product-integrity";
import { TAHA_WORKSPACE_ID } from "./integrations/store";

const DAY_MS = 24 * 60 * 60 * 1000;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const GOOGLE_REFRESH_RETRY_MS = 60 * 60 * 1000;

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

function publicationWindow(day: string) {
  const start = Date.parse(`${day}T00:00:00Z`) - VN_OFFSET_MS;
  return { start, end: start + DAY_MS };
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
  const day = publicationDay(now);
  const requestPrefix = `daily:${day}:%`;
  const existing = await database.prepare(
    `SELECT id, status FROM automation_runs
     WHERE workspace_id = ? AND request_key LIKE ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID, requestPrefix).first<{ id: string; status: string }>();
  if (existing) return { queued: false, day, reason: "already_planned", runId: existing.id };

  const connections = await database.prepare(
    `SELECT id, provider FROM channel_connections
     WHERE workspace_id = ? AND status = 'connected'
       AND provider = 'facebook' AND json_extract(config_json, '$.dailyAutomationEnabled') = 1`,
  ).bind(TAHA_WORKSPACE_ID).all<{ id: string; provider: string }>();
  const publishConnections = connections.results ?? [];
  if (!publishConnections.length) return { queued: false, day, reason: "no_publish_channels" };
  if (publishConnections.length !== 1) return { queued: false, day, reason: "ambiguous_publish_channels" };
  const facebookConnectionId = publishConnections[0].id;
  const window = publicationWindow(day);
  const scheduled = await database.prepare(
    `SELECT s.id FROM schedules s
     JOIN content_drafts d ON d.id = s.draft_id AND d.workspace_id = s.workspace_id
     WHERE s.workspace_id = ? AND s.connection_id = ? AND s.status = 'active'
       AND d.target_provider = 'facebook' AND s.run_at >= ? AND s.run_at < ?
     ORDER BY s.run_at LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID, facebookConnectionId, window.start, window.end).first<{ id: string }>();
  if (scheduled) return { queued: false, day, reason: "already_scheduled", scheduleId: scheduled.id };

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
     ORDER BY COALESCE((
       SELECT MAX(done.created_at) FROM automation_runs done
       WHERE done.workspace_id = p.workspace_id AND done.product_id = p.id AND done.status = 'completed'
     ), 0) ASC, p.updated_at ASC, p.base_sku ASC
     LIMIT 100`,
  ).bind(TAHA_WORKSPACE_ID).all<{ id: string; base_sku: string }>();
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
    idempotencyKey: `daily:${day}:${product.id}`,
  }, "daily-automation");
  return { queued: true, day, productId: product.id, sku: product.base_sku, run: queued.run };
}
