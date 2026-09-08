import { customerCopyViolation } from "./ai/shoe-content";
import { getRuntimeEnv } from "./integrations/env";
import { TAHA_WORKSPACE_ID } from "./integrations/store";
import { objectJson, productFingerprint, productSources } from "./product-integrity";
import { buildWebsiteProductPayload } from "./website-product";

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
  id: string | null;
  product_id: string;
  product_updated_at: number;
  target_provider: string | null;
  title: string | null;
  body: string | null;
  hashtags_json: string | null;
  platform_data_json: string | null;
  version: number | null;
  updated_at: number | null;
};

function database(override?: WebsiteBackfillDatabase) {
  const value = override ?? getRuntimeEnv().DB as unknown as WebsiteBackfillDatabase | undefined;
  if (!value) throw new Error("DATABASE_UNAVAILABLE");
  return value;
}

async function hashRevision(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (item) => item.toString(16).padStart(2, "0")).join("");
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

// A first-attempt local validation failure cannot have delivered a listing.
// Later attempts may follow an uncertain network request, so keep those blocked.
const preDeliveryFailure = `(j.attempt_count<=1 AND COALESCE(j.external_post_id,'')='' AND COALESCE(j.external_url,'')=''
  AND (COALESCE(j.error_code,'') GLOB 'PRODUCT_*' OR COALESCE(j.error_code,'') GLOB 'CONTENT_*'
    OR COALESCE(j.error_code,'') IN ('SKU_SOURCE_IMAGES_REQUIRED','MEDIA_NOT_FOUND','MEDIA_TOO_LARGE',
      'WEBSITE_MEDIA_PREPARE_FAILED','WEBSITE_PRODUCT_PAYLOAD_INVALID','WEBSITE_PRODUCT_SOURCE_INVALID',
      'WEBSITE_PRODUCT_SIZES_REQUIRED'))) `;

// Never replace in-flight/uncertain delivery. Fresh revisions can supersede a
// known pre-delivery failure; the previous revision guard still prevents loops.
const unresolvedJob = `(j.status IN ('queued','publishing','retry_wait','awaiting_confirmation')
  OR (j.status='blocked' AND NOT ${preDeliveryFailure})
  OR (j.status='published' AND (COALESCE(j.external_post_id,'')='' OR COALESCE(j.external_url,'')=''))
  OR (j.status IN ('failed','cancelled') AND j.attempt_count>0 AND NOT ${preDeliveryFailure})) `;

async function preparedListing(source: ReadyDraft, db: WebsiteBackfillDatabase) {
  const sources = await productSources(source.product_id, db);
  let platformData = objectJson(source.platform_data_json);
  const fingerprint = await productFingerprint(sources.product);
  if (!Number.isSafeInteger(sources.product.price_minor) || sources.product.price_minor <= 0) return null;
  // Every current original is included. The shared publishing media loader
  // verifies/compresses each image before sending, including large raw originals.
  const images = sources.images;
  if (!images.length || images.some((image) => {
    const metadata = objectJson(image.metadata_json);
    return !image.mime_type?.startsWith("image/") || !(metadata.md5Checksum || metadata.modifiedTime);
  })) return null;
  const currentCopy = platformData.sourceFingerprint === fingerprint && platformData.sku === sources.sku;
  let body = currentCopy ? source.target_provider === "website" ? source.body?.trim() || ""
    : typeof platformData.productDescription === "string" && platformData.productDescription.trim()
      ? platformData.productDescription.trim() : source.body?.trim() || "" : "";
  let hashtags: string[] = [];
  try { const value: unknown = JSON.parse(source.hashtags_json || "[]"); if (Array.isArray(value)) hashtags = value.filter((item): item is string => typeof item === "string"); } catch { /* legacy empty hashtags */ }
  let title = currentCopy && source.target_provider === "website" ? source.title || sources.product.name : sources.product.name;
  let sourceDraftId = source.id;
  if (!body || customerCopyViolation({ title, body, hashtags })) {
    // A website listing does not need a Facebook post. Canonical catalog copy
    // is already a valid source of product facts for new or changed products.
    body = sources.product.description.trim();
    title = sources.product.name;
    hashtags = [];
    platformData = {};
    sourceDraftId = null;
  }
  if (!body || customerCopyViolation({ title, body, hashtags })) return null;
  const contract = buildWebsiteProductPayload({
    jobId: "website-readiness", idempotencyKey: "website-readiness", product: sources.product,
    draft: { id: sourceDraftId || source.product_id, version: source.version || 1, title, body, hashtags, platformData },
    media: images.map((image) => ({ filename: image.id, mimeType: image.mime_type || "image/jpeg", dataBase64: "" })),
  });
  const versionedMedia = images.map((image) => {
    const metadata = objectJson(image.metadata_json);
    return [image.id, image.external_id, metadata.md5Checksum || metadata.modifiedTime];
  });
  // Inventory and website metadata are included so valid catalog updates are
  // upserted even when the copy does not need to be regenerated.
  const revision = await hashRevision([source.product_id, contract.product, versionedMedia]);
  return { title, body, hashtags, revision, images, sourceDraftId, platformData: {
    ...platformData, sku: sources.sku, sourceFingerprint: fingerprint,
    sourceImageCount: images.length, availableSourceImageCount: sources.images.length,
    generatedImageCount: 0, totalImageCount: images.length,
    websiteSourceDraftId: sourceDraftId, websiteReadyRevision: revision,
  } };
}

/**
 * Publishes every valid catalog revision without human approval or a social draft.
 * Facebook drafts and their daily schedules remain unchanged. Each website
 * revision gets an immutable draft and one immediately due, replay-safe schedule.
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
  let cursor = "";
  let checked = 0;
  let queued = 0;
  let skipped = 0;
  // Page past invalid/already delivered products so an early stale draft cannot
  // prevent later ready products from ever reaching the website.
  while (queued < limit) {
    const candidates = await db.prepare(
      `SELECT d.id,p.id AS product_id,p.updated_at AS product_updated_at,d.target_provider,d.title,d.body,d.hashtags_json,d.platform_data_json,d.version,d.updated_at
       FROM products p LEFT JOIN content_drafts d ON d.id=(
         SELECT latest.id FROM content_drafts latest
         WHERE latest.workspace_id=p.workspace_id AND latest.product_id=p.id
           AND latest.target_provider IN ('facebook','website') AND latest.archived_at IS NULL
           AND latest.status IN ('draft','in_review','approved') AND COALESCE(latest.generator,'')!='website-backfill'
         ORDER BY latest.updated_at DESC,(latest.target_provider='website') DESC,latest.id DESC LIMIT 1
       ) AND d.workspace_id=p.workspace_id
       WHERE p.workspace_id=? AND p.deleted_at IS NULL AND p.status='active' AND p.id>?
         AND NOT EXISTS (SELECT 1 FROM publish_jobs j JOIN channel_connections c ON c.id=j.connection_id
           WHERE j.workspace_id=p.workspace_id AND j.product_id=p.id AND c.provider='website' AND ${unresolvedJob})
       ORDER BY p.id LIMIT ?`,
    ).bind(TAHA_WORKSPACE_ID, cursor, MAX_LIMIT).all<ReadyDraft>();
    const page = candidates.results ?? [];
    if (!page.length) break;
    for (const source of page) {
      cursor = source.product_id;
      checked += 1;
      let listing: Awaited<ReturnType<typeof preparedListing>>;
      try { listing = await preparedListing(source, db); }
      catch (error) {
        if (!(error instanceof Error) || !/^(PRODUCT_|SKU_SOURCE_IMAGES_REQUIRED|WEBSITE_PRODUCT_)/.test(error.message)) throw error;
        listing = null;
      }
      if (!listing) { skipped += 1; continue; }
      const previous = await db.prepare(
        `SELECT id,platform_data_json FROM content_drafts
         WHERE workspace_id=? AND product_id=? AND target_provider='website' AND generator='website-backfill'
         ORDER BY created_at DESC,rowid DESC LIMIT 1`,
      ).bind(TAHA_WORKSPACE_ID, source.product_id).first<{ id: string; platform_data_json: string }>();
      if (objectJson(previous?.platform_data_json ?? null).websiteReadyRevision === listing.revision) {
        skipped += 1; continue;
      }
      // Include the preceding revision so an A → B → A catalog edit is a new
      // upsert, while repeated ticks for unchanged A still create only one job.
      const identity = await hashRevision([connectionId, listing.revision, previous?.id ?? null]);
      const draftId = `website-ready-${identity}`;
      const scheduleId = `website-immediate-${identity}`;
      const statements: Statement[] = [
        db.prepare(
          `INSERT INTO content_drafts
           (id,workspace_id,product_id,target_provider,content_type,language,title,body,hashtags_json,
            platform_data_json,status,version,generator,model,prompt_version,generation_meta_json,
            approved_by,approved_at,created_at,updated_at)
           SELECT ?,p.workspace_id,p.id,'website','product_listing','vi',?,?,?,?,'approved',1,
             'website-backfill',NULL,NULL,?,'automation:website-backfill',?,?,?
           FROM products p
           WHERE p.id=? AND p.workspace_id=? AND p.updated_at=? AND p.deleted_at IS NULL AND p.status='active'
             AND COALESCE((SELECT id FROM content_drafts prior WHERE prior.workspace_id=p.workspace_id
               AND prior.product_id=p.id AND prior.target_provider='website' AND prior.generator='website-backfill'
               ORDER BY prior.created_at DESC,prior.rowid DESC LIMIT 1),'')=?
             AND (? IS NULL OR EXISTS (SELECT 1 FROM content_drafts d
               WHERE d.id=? AND d.workspace_id=p.workspace_id AND d.product_id=p.id AND d.version=? AND d.updated_at=?
                 AND d.body=? AND d.platform_data_json=? AND d.archived_at IS NULL AND d.status IN ('draft','in_review','approved')))
             AND NOT EXISTS (SELECT 1 FROM publish_jobs j JOIN channel_connections c ON c.id=j.connection_id
               WHERE j.workspace_id=p.workspace_id AND j.product_id=p.id AND c.provider='website' AND ${unresolvedJob})
           ON CONFLICT(id) DO NOTHING`,
        ).bind(draftId, listing.title, listing.body, JSON.stringify(listing.hashtags), JSON.stringify(listing.platformData),
          JSON.stringify({ websiteSourceDraftId: listing.sourceDraftId, sourceDraftVersion: source.version, websiteReadyRevision: listing.revision }),
          now, now, now, source.product_id, TAHA_WORKSPACE_ID, source.product_updated_at, previous?.id ?? "",
          listing.sourceDraftId, listing.sourceDraftId, source.version, source.updated_at, source.body, source.platform_data_json),
      ];
      for (const [index, image] of listing.images.entries()) {
        statements.push(db.prepare(
          `INSERT OR IGNORE INTO content_draft_media
           (id,workspace_id,draft_id,media_id,role,sort_order,created_at)
           SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM content_drafts WHERE id=? AND workspace_id=? AND status='approved')`,
        ).bind(`website-media-${identity}-${index}`, TAHA_WORKSPACE_ID, draftId, image.id,
          index === 0 ? "primary" : "source", index, now, draftId, TAHA_WORKSPACE_ID));
      }
      // Supersede only schedules with no attempted delivery. The job guard above
      // is repeated here to remain safe against a concurrently running scheduler.
      statements.push(db.prepare(
        `UPDATE schedules SET status='paused',next_run_at=NULL,updated_at=?
         WHERE workspace_id=? AND connection_id=? AND status='active' AND id!=?
           AND draft_id IN (SELECT id FROM content_drafts WHERE workspace_id=? AND product_id=? AND target_provider='website')
           AND EXISTS (SELECT 1 FROM content_drafts WHERE id=? AND created_at=? AND status='approved')
           AND NOT EXISTS (SELECT 1 FROM publish_jobs j WHERE j.workspace_id=? AND j.product_id=? AND j.connection_id=? AND ${unresolvedJob})`,
      ).bind(now, TAHA_WORKSPACE_ID, connectionId, scheduleId, TAHA_WORKSPACE_ID, source.product_id,
        draftId, now, TAHA_WORKSPACE_ID, source.product_id, connectionId));
      statements.push(db.prepare(
        `INSERT INTO schedules
         (id,workspace_id,draft_id,connection_id,status,schedule_kind,run_at,weekdays_json,timezone,
          next_run_at,execution_mode,publish_options_json,created_by,created_at,updated_at)
         SELECT ?,?,?,?,'active','once',?,'[]','Asia/Ho_Chi_Minh',?,'auto','{}','automation:website-backfill',?,?
         WHERE EXISTS (SELECT 1 FROM content_drafts WHERE id=? AND workspace_id=? AND status='approved')
         ON CONFLICT(id) DO NOTHING`,
      ).bind(scheduleId, TAHA_WORKSPACE_ID, draftId, connectionId, now, now, now, now, draftId, TAHA_WORKSPACE_ID));
      const results = await db.batch(statements);
      if (resultChanges(results[0]) > 0 && resultChanges(results.at(-1)) > 0) queued += 1;
      else skipped += 1;
      if (queued >= limit) break;
    }
    if (page.length < MAX_LIMIT) break;
  }
  return { enabled: true, checked, queued, skipped };
}
