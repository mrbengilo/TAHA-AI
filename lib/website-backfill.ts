import { getRuntimeEnv } from "./integrations/env";
import { TAHA_WORKSPACE_ID } from "./integrations/store";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type Result = { meta?: { changes?: number } };
type Statement = {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results?: T[] }>;
  run(): Promise<Result>;
};
export type WebsiteBackfillDatabase = {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<Result[]>;
};

type ReadyDraft = {
  id: string;
  product_id: string;
  title: string | null;
  body: string;
  hashtags_json: string;
  platform_data_json: string;
  version: number;
  product_name: string;
  base_sku: string;
};

function database(override?: WebsiteBackfillDatabase) {
  const value = override ?? getRuntimeEnv().DB as unknown as WebsiteBackfillDatabase | undefined;
  if (!value) throw new Error("DATABASE_UNAVAILABLE");
  return value;
}

function jsonRecord(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function resultChanges(value: Result | undefined) {
  return Number(value?.meta?.changes ?? 0);
}

export type WebsiteReadyBackfillResult = {
  enabled: boolean;
  checked: number;
  queued: number;
  skipped: number;
  reason?: string;
};

/**
 * Clones the latest approved Facebook copy into an independent website listing
 * and makes it due immediately. Stable IDs and SQL conflict guards make the
 * operation replay-safe across cron retries.
 */
export async function ensureWebsiteReadyBackfill(options: {
  database?: WebsiteBackfillDatabase;
  now?: number;
  limit?: number;
  enabled?: boolean;
} = {}): Promise<WebsiteReadyBackfillResult> {
  const enabled = options.enabled ?? getRuntimeEnv().WEBSITE_READY_BACKFILL_ENABLED === "1";
  if (!enabled) return { enabled: false, checked: 0, queued: 0, skipped: 0, reason: "disabled" };
  const db = database(options.database);
  const now = Math.floor(options.now ?? Date.now());
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  const connections = await db.prepare(
    "SELECT id FROM channel_connections WHERE workspace_id=? AND provider='website' AND status='connected' AND publish_mode='api' ORDER BY created_at",
  ).bind(TAHA_WORKSPACE_ID).all<{ id: string }>();
  if ((connections.results ?? []).length !== 1) {
    return { enabled: true, checked: 0, queued: 0, skipped: 0, reason: "website_connection_required" };
  }
  const connectionId = connections.results![0].id;
  const candidates = await db.prepare(
    `SELECT d.id,d.product_id,d.title,d.body,d.hashtags_json,d.platform_data_json,d.version,
            p.name AS product_name,p.base_sku
     FROM content_drafts d JOIN products p ON p.id=d.product_id AND p.workspace_id=d.workspace_id
     WHERE d.workspace_id=? AND d.target_provider='facebook' AND d.status='approved'
       AND d.archived_at IS NULL AND p.deleted_at IS NULL AND p.status='active'
       AND NOT EXISTS (
         SELECT 1 FROM content_drafts website
         WHERE website.workspace_id=d.workspace_id AND website.product_id=d.product_id
           AND website.target_provider='website' AND website.archived_at IS NULL
           AND website.status IN ('draft','in_review','approved')
       )
       AND d.updated_at=(
         SELECT MAX(latest.updated_at) FROM content_drafts latest
         WHERE latest.workspace_id=d.workspace_id AND latest.product_id=d.product_id
           AND latest.target_provider='facebook' AND latest.status='approved' AND latest.archived_at IS NULL
       )
     ORDER BY d.updated_at ASC,d.id ASC LIMIT ?`,
  ).bind(TAHA_WORKSPACE_ID, limit).all<ReadyDraft>();

  const seenProducts = new Set<string>();
  let queued = 0;
  let skipped = 0;
  for (const source of candidates.results ?? []) {
    if (seenProducts.has(source.product_id)) { skipped += 1; continue; }
    seenProducts.add(source.product_id);
    const media = await db.prepare(
      `SELECT media_id,role,sort_order FROM content_draft_media
       WHERE workspace_id=? AND draft_id=? ORDER BY sort_order,created_at LIMIT 7`,
    ).bind(TAHA_WORKSPACE_ID, source.id).all<{ media_id: string; role: string; sort_order: number }>();
    const selected = (media.results ?? []).slice(0, 6);
    if (!selected.length || (media.results ?? []).length > 6) { skipped += 1; continue; }
    const platformData = jsonRecord(source.platform_data_json);
    const body = typeof platformData.productDescription === "string" && platformData.productDescription.trim()
      ? platformData.productDescription.trim() : source.body;
    const draftId = `website-ready:${source.id}`;
    const scheduleId = `website-immediate:${source.id}`;
    const statements: Statement[] = [
      db.prepare(
        `INSERT INTO content_drafts
         (id,workspace_id,product_id,target_provider,content_type,language,title,body,hashtags_json,
          platform_data_json,status,version,generator,model,prompt_version,generation_meta_json,
          approved_by,approved_at,created_at,updated_at)
         SELECT ?,?,?,?,?, 'vi',?,?,?,?, 'approved',1,'website-backfill',d.model,d.prompt_version,?,?,?, ?,?
         FROM content_drafts d
         WHERE d.id=? AND d.workspace_id=? AND d.status='approved'
           AND NOT EXISTS (SELECT 1 FROM content_drafts w WHERE w.workspace_id=d.workspace_id
             AND w.product_id=d.product_id AND w.target_provider='website' AND w.archived_at IS NULL
             AND w.status IN ('draft','in_review','approved'))
         ON CONFLICT(id) DO NOTHING`,
      ).bind(
        draftId, TAHA_WORKSPACE_ID, source.product_id, "website", "product_listing",
        source.product_name, body, source.hashtags_json,
        JSON.stringify({ ...platformData, sku: source.base_sku, websiteSourceDraftId: source.id }),
        JSON.stringify({ websiteSourceDraftId: source.id, sourceDraftVersion: source.version }),
        `automation:website-backfill`, now, now, now, source.id, TAHA_WORKSPACE_ID,
      ),
    ];
    for (const [index, item] of selected.entries()) {
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO content_draft_media
         (id,workspace_id,draft_id,media_id,role,sort_order,created_at)
         SELECT ?,?,?,?,?,?,? WHERE EXISTS (
           SELECT 1 FROM content_drafts WHERE id=? AND workspace_id=? AND status='approved')`,
      ).bind(`website-media:${source.id}:${index}`, TAHA_WORKSPACE_ID, draftId, item.media_id,
        index === 0 ? "primary" : "attachment", index, now, draftId, TAHA_WORKSPACE_ID));
    }
    statements.push(db.prepare(
      `INSERT INTO schedules
       (id,workspace_id,draft_id,connection_id,status,schedule_kind,run_at,weekdays_json,timezone,
        next_run_at,execution_mode,publish_options_json,created_by,created_at,updated_at)
       SELECT ?,?,?,?,'active','once',?,'[]','Asia/Ho_Chi_Minh',?,'auto','{}',?,?,?
       WHERE EXISTS (SELECT 1 FROM content_drafts WHERE id=? AND workspace_id=? AND status='approved')
       ON CONFLICT(id) DO NOTHING`,
    ).bind(scheduleId, TAHA_WORKSPACE_ID, draftId, connectionId, now, now,
      `automation:website-backfill:${source.id}`, now, now, draftId, TAHA_WORKSPACE_ID));
    const results = await db.batch(statements);
    if (resultChanges(results[0]) > 0 && resultChanges(results.at(-1)) > 0) queued += 1;
    else skipped += 1;
  }
  return { enabled: true, checked: (candidates.results ?? []).length, queued, skipped };
}
