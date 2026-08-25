import { queueAutomationRun } from "./automation";
import { getRuntimeEnv } from "./integrations/env";
import { syncGoogleCatalog } from "./integrations/google-sync";
import { TAHA_WORKSPACE_ID } from "./integrations/store";

const DAY_MS = 24 * 60 * 60 * 1000;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const TARGETS = ["facebook", "zalo_personal", "website"] as const;

type Target = (typeof TARGETS)[number];

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

export async function ensureDailyProductAutomation(now = Date.now()) {
  const database = db();
  const day = publicationDay(now);
  const requestPrefix = `daily:${day}:%`;
  const existing = await database.prepare(
    `SELECT id, status FROM automation_runs
     WHERE workspace_id = ? AND request_key LIKE ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID, requestPrefix).first<{ id: string; status: string }>();
  if (existing) return { queued: false, day, reason: "already_planned", runId: existing.id };

  const google = await database.prepare(
    `SELECT id, last_synced_at FROM channel_connections
     WHERE workspace_id = ? AND provider = 'google' AND status = 'connected'
     ORDER BY updated_at DESC LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID).first<{ id: string; last_synced_at: number | null }>();
  if (!google) return { queued: false, day, reason: "google_not_connected" };
  if (!google.last_synced_at || now - google.last_synced_at > 6 * 60 * 60 * 1000) {
    await syncGoogleCatalog(google.id);
  }

  const connections = await database.prepare(
    `SELECT provider FROM channel_connections
     WHERE workspace_id = ? AND status = 'connected'
       AND provider IN ('facebook', 'zalo_personal', 'website')`,
  ).bind(TAHA_WORKSPACE_ID).all<{ provider: string }>();
  const connected = new Set((connections.results ?? []).map((row) => row.provider));
  const targets = TARGETS.filter((provider) => connected.has(provider)) as Target[];
  if (!targets.length) return { queued: false, day, reason: "no_publish_channels" };

  const product = await database.prepare(
    `SELECT p.id, p.base_sku
     FROM products p
     WHERE p.workspace_id = ? AND p.deleted_at IS NULL AND p.status = 'active'
       AND (SELECT COUNT(DISTINCT m.id)
            FROM product_media pm JOIN media_assets m ON m.id = pm.media_id AND m.workspace_id = pm.workspace_id
            WHERE pm.workspace_id = p.workspace_id AND pm.product_id = p.id
              AND m.media_type = 'image' AND m.origin = 'source' AND m.status = 'ready') >= 2
       AND NOT EXISTS (
         SELECT 1 FROM automation_runs active
         WHERE active.workspace_id = p.workspace_id AND active.product_id = p.id
           AND active.status IN ('queued', 'processing')
       )
     ORDER BY COALESCE((
       SELECT MAX(done.created_at) FROM automation_runs done
       WHERE done.workspace_id = p.workspace_id AND done.product_id = p.id AND done.status = 'completed'
     ), 0) ASC, p.updated_at ASC, p.base_sku ASC
     LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID).first<{ id: string; base_sku: string }>();
  if (!product) return { queued: false, day, reason: "no_ready_product" };

  const queued = await queueAutomationRun({
    productId: product.id,
    imageCount: 6,
    targetProviders: targets,
    idempotencyKey: `daily:${day}:${product.id}`,
  }, "daily-automation");
  return { queued: true, day, productId: product.id, sku: product.base_sku, run: queued.run };
}
