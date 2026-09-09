import { syncGoogleCatalog } from "./integrations/google-sync";
import {
  legacyProductFingerprint,
  objectJson,
  PRODUCT_FINGERPRINT_VERSION,
  productFingerprint,
  productSourceConnection,
  productSources,
} from "./product-integrity";
import { assertPublishProductMedia } from "./publish-media-integrity";
import { getRuntimeEnv } from "./integrations/env";
import {
  PublishDeliveryError,
  recordFacebookMapping,
  sendFacebookPost,
  sendWebsitePayload,
} from "./publishing";
import { recordTikTokShopMappings, sendTikTokShopListing } from "./tiktok-shop-publishing";
import { customerCopyViolation } from "./ai/shoe-content";
import { APPROVED_TEMPLATE_MODEL, CANONICAL_ARTICLE_VERSION, generateProductContent } from "./ai/template";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_LEASE_MS = 10 * 60 * 1_000;
const MAX_BACKOFF_MS = 15 * 60 * 1_000;
const FACEBOOK_STALE_FINGERPRINT_RECOVERY = "product-copy-v2-compat-20260909";

type Provider = "google" | "facebook" | "zalo_personal" | "shopee" | "tiktok_shop" | "website";
type JobKind = "social_post" | "listing_upsert" | "listing_unpublish" | "inventory_sync";

type CandidateJob = {
  id: string;
  workspace_id: string;
  connection_id: string;
  product_id: string | null;
  draft_id: string | null;
  job_kind: JobKind;
  dedupe_key: string;
  payload_snapshot_json: string;
  provider_response_json: string;
  external_post_id: string | null;
  external_url: string | null;
  error_code: string | null;
  attempt_count: number;
  max_attempts: number;
  provider: Provider;
  connection_status: string;
  publish_mode: string;
};

type LeasedAttempt = {
  attempt_count: number;
  max_attempts: number;
};

type TikTokMappingCandidate = {
  id: string;
  workspace_id: string;
  connection_id: string;
  product_id: string;
  payload_snapshot_json: string;
  provider_response_json: string;
  external_post_id: string;
  external_url: string | null;
};

type ProductArticleRow = {
  id: string;
  title: string;
  body: string;
  hashtags_json: string;
};

type D1WriteResult = { meta?: { changes?: number } };

type DispatcherStatement = {
  bind(...values: unknown[]): DispatcherStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results?: T[] }>;
  run(): Promise<D1WriteResult>;
};

export type DispatcherDatabase = {
  prepare(query: string): DispatcherStatement;
};

type RemoteResult = {
  externalId: string;
  externalUrl: string | null;
  providerResponse: Record<string, unknown>;
};

export type DispatcherPublishers = {
  facebook(input: { connectionId: string; message: string; mediaIds: string[]; assertLease?: () => Promise<void> }): Promise<RemoteResult>;
  website(input: {
    connectionId: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    jobId: string;
  }): Promise<RemoteResult>;
  recordFacebook(input: {
    connectionId: string;
    jobId: string;
    externalId: string;
    externalUrl: string;
  }): Promise<boolean>;
  tiktokShop(input: {
    connectionId: string;
    jobId: string;
    workerId: string;
    productId: string;
    payload: Record<string, unknown>;
    progress: Record<string, unknown>;
    externalId: string | null;
  }): Promise<RemoteResult>;
  recordTikTokShop(input: {
    connectionId: string;
    productId: string;
    externalId: string;
    providerResponse: Record<string, unknown>;
    payload: Record<string, unknown>;
  }): Promise<boolean>;
};

export type DispatcherOptions = {
  database?: DispatcherDatabase;
  publishers?: DispatcherPublishers;
  now?: number;
  limit?: number;
  leaseMs?: number;
  workerId?: string;
  jobIds?: string[];
};

export type DispatcherResult = {
  checked: number;
  leased: number;
  published: number;
  retrying: number;
  blocked: number;
  failed: number;
  skipped: number;
  recoveredRetrying: number;
  recoveredBlocked: number;
  reconciledMappings: number;
  errors: Array<{ jobId: string; code: string }>;
  dispatchedAt: number;
};

const defaultPublishers: DispatcherPublishers = {
  facebook: sendFacebookPost,
  website: sendWebsitePayload,
  recordFacebook: recordFacebookMapping,
  tiktokShop: sendTikTokShopListing,
  recordTikTokShop: recordTikTokShopMappings,
};

const transientGoogleErrors = new Set(["GOOGLE_SYNC_IN_PROGRESS", "GOOGLE_DRIVE_TEMPORARY_FAILURE", "GOOGLE_DRIVE_UNAVAILABLE", "GOOGLE_SHEETS_UNAVAILABLE", "GOOGLE_SHEETS_REQUEST_FAILED", "GOOGLE_MEDIA_TEMPORARY_FAILURE", "GOOGLE_MEDIA_UNAVAILABLE"]);

function dispatcherDatabase(override?: DispatcherDatabase) {
  const database = override ?? (getRuntimeEnv().DB as unknown as DispatcherDatabase | undefined);
  if (!database) throw new Error("DATABASE_UNAVAILABLE");
  return database;
}

function resultChanges(result: D1WriteResult) {
  return Number(result.meta?.changes ?? 0);
}

function parsePayload(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_JOB_PAYLOAD");
    return parsed as Record<string, unknown>;
  } catch {
    throw new PublishDeliveryError("INVALID_JOB_PAYLOAD");
  }
}

function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedHashtags(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => cleanText(item, 80).replace(/^#+/, "")).filter(Boolean))].slice(0, 20)
    : [];
}

function normalizedProductList(value: unknown, maxItems: number, maxLength: number) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => cleanText(item, maxLength)).filter(Boolean))].slice(0, maxItems)
    : [];
}

async function stableArticleId(workspaceId: string, productId: string) {
  const bytes = new TextEncoder().encode(`${workspaceId}:${productId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((item) => item.toString(16).padStart(2, "0")).join("");
  return `article_${hex.slice(0, 40)}`;
}

async function upgradeLegacyProductPayload(
  database: DispatcherDatabase,
  job: CandidateJob,
  payload: Record<string, unknown>,
  platformData: Record<string, unknown>,
  sources: Awaited<ReturnType<typeof productSources>>,
  currentFingerprint: string,
) {
  const expected = cleanText(platformData.sourceFingerprint, 128);
  const version = cleanText(platformData.sourceFingerprintVersion, 80);
  const templateVersion = cleanText(platformData.contentTemplateVersion, 120);
  const legacyTemplate = templateVersion === "taha-approved-template-v1"
    || templateVersion === "taha-approved-template-v2";
  const explicitRecovery = cleanText(platformData.fingerprintRecovery, 120)
    === FACEBOOK_STALE_FINGERPRINT_RECOVERY;

  const articleId = await stableArticleId(job.workspace_id, job.product_id!);
  let article = await database.prepare(
    `SELECT id,title,body,hashtags_json FROM product_articles
     WHERE workspace_id=? AND product_id=? AND source_fingerprint=?
       AND article_version=? AND prompt_version=? LIMIT 1`,
  ).bind(job.workspace_id, job.product_id, currentFingerprint,
    CANONICAL_ARTICLE_VERSION, APPROVED_TEMPLATE_MODEL).first<ProductArticleRow>();

  if (!article) {
    if (!explicitRecovery && (version || !legacyTemplate || !expected)) {
      throw new Error("PRODUCT_CONTENT_STALE");
    }
    let title = cleanText(payload.title, 255) || cleanText(sources.product.name, 255);
    let body = cleanText(payload.message, 20_000);
    let hashtags = normalizedHashtags(payload.hashtags);
    let sourceCorrections = ["legacy_fingerprint_upgraded"];
    if (explicitRecovery || expected !== await legacyProductFingerprint(sources.product)) {
      const metadata = record(objectJson(sources.product.metadata_json).website);
      const sizes = normalizedProductList(metadata.sizes, 30, 40);
      if (!sizes.length) throw new Error("PRODUCT_SIZES_REQUIRED");
      const generated = await generateProductContent({
        product: {
          sku: sources.product.base_sku,
          name: sources.product.name,
          description: sources.product.description,
          brand: sources.product.brand,
          category: sources.product.category,
          currency: sources.product.currency,
          priceMinor: sources.product.price_minor,
          compareAtPriceMinor: sources.product.compare_at_price_minor,
          inventoryQuantity: sources.product.inventory_quantity,
          sizes,
          colors: normalizedProductList(metadata.colors, 30, 160),
          gifts: normalizedProductList(metadata.gifts, 20, 160),
          specifications: normalizedProductList(metadata.specifications, 80, 160),
        },
        targetProviders: ["facebook"],
      });
      const generatedContent = record(generated.content);
      const generatedArticle = record(generatedContent.canonicalArticle);
      if (cleanText(generatedArticle.version, 80) !== CANONICAL_ARTICLE_VERSION) {
        throw new Error("PRODUCT_CONTENT_STALE");
      }
      title = cleanText(generatedArticle.title, 255);
      body = cleanText(generatedArticle.body, 20_000);
      hashtags = normalizedHashtags(generatedArticle.hashtags);
      sourceCorrections = normalizedProductList(generatedContent.sourceCorrections, 30, 120);
    }
    if (!title || !body) throw new Error("PRODUCT_CONTENT_STALE");
    const now = Date.now();
    await database.prepare(
      `INSERT INTO product_articles
       (id,workspace_id,product_id,sku,title,body,hashtags_json,article_version,source_fingerprint,
        source_corrections_json,generator,model,prompt_version,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'template',?,?,?,?)
       ON CONFLICT(workspace_id,product_id) DO UPDATE SET
         sku=excluded.sku,title=excluded.title,body=excluded.body,hashtags_json=excluded.hashtags_json,
         article_version=excluded.article_version,source_fingerprint=excluded.source_fingerprint,
         source_corrections_json=excluded.source_corrections_json,generator=excluded.generator,
         model=excluded.model,prompt_version=excluded.prompt_version,updated_at=excluded.updated_at`,
    ).bind(articleId, job.workspace_id, job.product_id, sources.sku, title, body, JSON.stringify(hashtags),
      CANONICAL_ARTICLE_VERSION, currentFingerprint, JSON.stringify(sourceCorrections), APPROVED_TEMPLATE_MODEL,
      APPROVED_TEMPLATE_MODEL, now, now).run();
    article = await database.prepare(
      `SELECT id,title,body,hashtags_json FROM product_articles
       WHERE workspace_id=? AND product_id=? AND source_fingerprint=?
         AND article_version=? AND prompt_version=? LIMIT 1`,
    ).bind(job.workspace_id, job.product_id, currentFingerprint,
      CANONICAL_ARTICLE_VERSION, APPROVED_TEMPLATE_MODEL).first<ProductArticleRow>();
  }
  if (!article) throw new Error("PRODUCT_CONTENT_STALE");

  const hashtags = normalizedHashtags(JSON.parse(article.hashtags_json));
  const upgradedData = {
    ...platformData,
    canonicalArticleId: article.id,
    sourceFingerprint: currentFingerprint,
    sourceFingerprintVersion: PRODUCT_FINGERPRINT_VERSION,
    contentTemplateVersion: APPROVED_TEMPLATE_MODEL,
  };
  payload.title = article.title;
  payload.message = article.body;
  payload.hashtags = hashtags;
  payload.platformData = upgradedData;

  if (job.draft_id) {
    await database.prepare(
      `UPDATE content_drafts SET title=?,body=?,hashtags_json=?,platform_data_json=?,
       generation_meta_json=json_set(CASE WHEN json_valid(generation_meta_json) THEN generation_meta_json ELSE '{}' END,
         '$.canonicalArticleId',?),generator='template',model=?,prompt_version=?,version=version+1,updated_at=?
       WHERE id=? AND workspace_id=? AND product_id=?`,
    ).bind(article.title, article.body, JSON.stringify(hashtags), JSON.stringify(upgradedData), article.id,
      APPROVED_TEMPLATE_MODEL, APPROVED_TEMPLATE_MODEL, Date.now(), job.draft_id, job.workspace_id, job.product_id).run();
  }
  return upgradedData;
}

function facebookPayload(payload: Record<string, unknown>) {
  const message = typeof payload.message === "string" ? payload.message : "";
  const hashtags = Array.isArray(payload.hashtags)
    ? payload.hashtags
      .filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value: string) => `#${value.trim().replace(/^#+/, "")}`)
    : [];
  const mediaIds = Array.isArray(payload.mediaIds)
    ? payload.mediaIds.filter((value: unknown): value is string => typeof value === "string")
    : [];
  const caption = [message.trim(), hashtags.join(" ")].filter(Boolean).join("\n\n");
  if (!caption && mediaIds.length === 0) throw new PublishDeliveryError("INVALID_JOB_PAYLOAD");
  return { message: caption, mediaIds };
}

export function retryDelayMs(attemptCount: number) {
  const exponent = Math.max(0, Math.min(10, Math.floor(attemptCount) - 1));
  return Math.min(MAX_BACKOFF_MS, 30_000 * (2 ** exponent));
}

function errorDetails(error: unknown) {
  if (error instanceof PublishDeliveryError) {
    return {
      code: error.code,
      retryable: error.retryable || transientGoogleErrors.has(error.code),
      outcomeUnknown: error.outcomeUnknown,
    };
  }
  const shaped = error as { code?: unknown; retryable?: unknown; outcomeUnknown?: unknown } | null;
  const code = error instanceof Error ? error.message : typeof shaped?.code === "string" ? shaped.code : "PUBLISH_FAILED";
  const blocked = code === "CONNECTION_NOT_FOUND"
    || code === "CONNECTION_CREDENTIALS_MISSING"
    || code.endsWith("_REAUTH_REQUIRED")
    || code.startsWith("INVALID_")
    || code === "MEDIA_NOT_FOUND"
    || code === "MEDIA_TOO_LARGE"
    || code === "EXTERNAL_MEDIA_DISABLED"
    || /^FACEBOOK_API_4\d\d$/.test(code) && code !== "FACEBOOK_API_429"
    || /^WEBSITE_API_4\d\d$/.test(code) && code !== "WEBSITE_API_429";
  return {
    code,
    retryable: transientGoogleErrors.has(code) || (typeof shaped?.retryable === "boolean" ? shaped.retryable : !blocked && !code.startsWith("GOOGLE_")),
    outcomeUnknown: shaped?.outcomeUnknown === true,
  };
}

function isTikTokOperatorBlock(code: string) {
  return code === "TIKTOK_JOB_KIND_UNSUPPORTED"
    || code === "TIKTOK_PRODUCT_ID_REQUIRED"
    || code === "TIKTOK_PRODUCT_NOT_FOUND"
    || code === "TIKTOK_PRODUCT_SNAPSHOT_INVALID"
    || code === "TIKTOK_SHOP_CIPHER_MISSING"
    || code === "TIKTOK_LISTING_CONFIG_REQUIRED"
    || code === "TIKTOK_CATEGORY_REQUIRED"
    || code === "TIKTOK_WAREHOUSE_REQUIRED"
    || code === "TIKTOK_PACKAGE_WEIGHT_REQUIRED"
    || code === "TIKTOK_PACKAGE_WEIGHT_UNIT_REQUIRED"
    || code === "TIKTOK_TITLE_LENGTH_INVALID"
    || code === "TIKTOK_DESCRIPTION_INVALID"
    || code === "TIKTOK_CURRENCY_INVALID"
    || code === "TIKTOK_MAIN_IMAGES_INVALID"
    || code === "TIKTOK_VARIANTS_INVALID"
    || code === "TIKTOK_SKU_INVALID"
    || code === "TIKTOK_PRICE_INVALID"
    || code === "TIKTOK_INVENTORY_INVALID"
    || code === "TIKTOK_SALES_ATTRIBUTES_REQUIRED"
    || code === "TIKTOK_IMAGE_TYPE_UNSUPPORTED"
    || code === "TIKTOK_PRODUCT_PUBLISH_IN_FLIGHT"
    || code === "TIKTOK_PRODUCT_RECONCILIATION_REQUIRED"
    || code === "TIKTOK_PRODUCT_UPDATE_REQUIRES_REMOTE_SNAPSHOT";
}

async function recoverExpiredLeases(database: DispatcherDatabase, now: number, jobIds?: string[]) {
  const jobFilter = jobIds ? ` AND id IN (${jobIds.map(() => "?").join(",")})` : "";
  const website = await database.prepare(
    `UPDATE publish_jobs SET status = 'retry_wait', available_at = ?, lease_owner = NULL,
     lease_expires_at = NULL, error_code = 'LEASE_EXPIRED_RETRY',
     error_message = 'Worker dừng giữa lần gửi; website sẽ chống trùng bằng idempotency key.', updated_at = ?
     WHERE status = 'publishing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
       AND connection_id IN (SELECT id FROM channel_connections WHERE provider = 'website')${jobFilter}`,
  ).bind(now, now, now, ...(jobIds ?? [])).run();
  const uncertain = await database.prepare(
    `UPDATE publish_jobs SET status = 'blocked', lease_expires_at = NULL,
     error_code = 'DELIVERY_OUTCOME_UNKNOWN',
     error_message = 'Worker dừng sau khi bắt đầu gửi; cần đối soát kênh trước khi thử lại.', updated_at = ?
     WHERE status = 'publishing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?${jobFilter}`,
  ).bind(now, now, ...(jobIds ?? [])).run();
  return {
    retrying: resultChanges(website),
    blocked: resultChanges(uncertain),
  };
}

async function leaseJob(
  database: DispatcherDatabase,
  job: CandidateJob,
  workerId: string,
  now: number,
  leaseMs: number,
) {
  return database.prepare(
    `UPDATE publish_jobs SET status = 'publishing', attempt_count = attempt_count + 1,
     lease_owner = ?, lease_expires_at = ?, started_at = COALESCE(started_at, ?),
     error_code = NULL, error_message = NULL, completed_at = NULL, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status IN ('queued', 'retry_wait')
       AND available_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       AND payload_snapshot_json = ?
       AND (draft_id IS NULL OR EXISTS (SELECT 1 FROM content_drafts d WHERE d.id = publish_jobs.draft_id
         AND d.workspace_id = publish_jobs.workspace_id AND d.status = 'approved'))
     RETURNING attempt_count, max_attempts`,
  ).bind(
    workerId,
    now + leaseMs,
    now,
    now,
    job.id,
    job.workspace_id,
    now,
    now,
    job.payload_snapshot_json,
  ).first<LeasedAttempt>();
}

async function markPublished(
  database: DispatcherDatabase,
  job: CandidateJob,
  workerId: string,
  result: RemoteResult,
  now: number,
) {
  const updated = await database.prepare(
    `UPDATE publish_jobs SET status = 'published', external_post_id = ?, external_url = ?,
     provider_response_json = ?, lease_owner = NULL, lease_expires_at = NULL,
     completed_at = ?, updated_at = ?, error_code = NULL, error_message = NULL
     WHERE id = ? AND workspace_id = ? AND lease_owner = ?
       AND (status = 'publishing' OR (status = 'blocked' AND error_code = 'DELIVERY_OUTCOME_UNKNOWN' AND external_post_id = ?))
     RETURNING id`,
  ).bind(
    result.externalId,
    result.externalUrl,
    JSON.stringify(result.providerResponse),
    now,
    now,
    job.id,
    job.workspace_id,
    workerId,
    result.externalId,
  ).first<{ id: string }>();
  return Boolean(updated);
}

async function markBlocked(
  database: DispatcherDatabase,
  job: CandidateJob,
  workerId: string,
  code: string,
  message: string,
  now: number,
) {
  const result = await database.prepare(
    `UPDATE publish_jobs SET status = 'blocked', error_code = ?, error_message = ?,
     lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status = 'publishing' AND lease_owner = ?`,
  ).bind(code, message.slice(0, 500), now, job.id, job.workspace_id, workerId).run();
  return resultChanges(result) > 0;
}

async function markAcceptedBlocked(
  database: DispatcherDatabase,
  job: CandidateJob,
  workerId: string,
  result: RemoteResult,
  code: string,
  message: string,
  now: number,
) {
  const updated = await database.prepare(
    `UPDATE publish_jobs SET status = 'blocked', external_post_id = ?, external_url = ?,
     provider_response_json = ?, error_code = ?, error_message = ?, lease_owner = NULL,
     lease_expires_at = NULL, completed_at = NULL, updated_at = ?
     WHERE id = ? AND workspace_id = ?
       AND (
         (status = 'publishing' AND lease_owner = ?)
         OR (status = 'blocked' AND error_code = 'DELIVERY_OUTCOME_UNKNOWN' AND external_post_id = ?)
       )`,
  ).bind(
    result.externalId,
    result.externalUrl,
    JSON.stringify(result.providerResponse),
    code,
    message.slice(0, 500),
    now,
    job.id,
    job.workspace_id,
    workerId,
    result.externalId,
  ).run();
  return resultChanges(updated) > 0;
}

async function persistAcceptedReceipt(
  database: DispatcherDatabase,
  job: CandidateJob,
  workerId: string,
  result: RemoteResult,
  now: number,
) {
  const updated = await database.prepare(
    `UPDATE publish_jobs SET external_post_id = ?, external_url = ?, provider_response_json = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ?
       AND (
         (status = 'publishing' AND lease_owner = ?)
         OR (status = 'blocked' AND error_code = 'DELIVERY_OUTCOME_UNKNOWN' AND external_post_id IS NULL AND lease_owner = ?)
       )`,
  ).bind(
    result.externalId,
    result.externalUrl,
    JSON.stringify(result.providerResponse),
    now,
    job.id,
    job.workspace_id,
    workerId,
    workerId,
  ).run();
  return resultChanges(updated) > 0;
}

async function reconcileTikTokMappings(
  database: DispatcherDatabase,
  publishers: DispatcherPublishers,
  now: number,
  limit: number,
) {
  const finalized = await database.prepare(
    `UPDATE publish_jobs SET status = 'published', error_code = NULL, error_message = NULL,
     completed_at = COALESCE(completed_at, ?), updated_at = ?
     WHERE status = 'blocked' AND product_id IS NOT NULL AND external_post_id IS NOT NULL
       AND connection_id IN (
         SELECT id FROM channel_connections WHERE provider = 'tiktok_shop'
       )
       AND EXISTS (
         SELECT 1 FROM channel_mappings mapped
         WHERE mapped.workspace_id = publish_jobs.workspace_id
           AND mapped.connection_id = publish_jobs.connection_id
           AND mapped.entity_type = 'product' AND mapped.entity_id = publish_jobs.product_id
           AND mapped.external_id = publish_jobs.external_post_id
       )`,
  ).bind(now, now).run();
  const candidates = await database.prepare(
    `SELECT j.id, j.workspace_id, j.connection_id, j.product_id, j.payload_snapshot_json,
            j.provider_response_json, j.external_post_id, j.external_url
     FROM publish_jobs j
     JOIN channel_connections c ON c.id = j.connection_id AND c.workspace_id = j.workspace_id
     WHERE c.provider = 'tiktok_shop' AND j.product_id IS NOT NULL
       AND j.external_post_id IS NOT NULL AND j.status IN ('blocked', 'published')
       AND NOT EXISTS (
         SELECT 1 FROM channel_mappings mapped
         WHERE mapped.workspace_id = j.workspace_id AND mapped.connection_id = j.connection_id
           AND mapped.entity_type = 'product' AND mapped.entity_id = j.product_id
       )
     ORDER BY j.updated_at ASC LIMIT ?`,
  ).bind(limit).all<TikTokMappingCandidate>();
  let reconciled = resultChanges(finalized);
  const errors: Array<{ jobId: string; code: string }> = [];

  for (const job of candidates.results ?? []) {
    let recorded = false;
    try {
      recorded = await publishers.recordTikTokShop({
        connectionId: job.connection_id,
        productId: job.product_id,
        externalId: job.external_post_id,
        providerResponse: parsePayload(job.provider_response_json),
        payload: parsePayload(job.payload_snapshot_json),
      });
    } catch {
      recorded = false;
    }

    if (recorded) {
      const updated = await database.prepare(
        `UPDATE publish_jobs SET status = 'published', error_code = NULL, error_message = NULL,
         completed_at = COALESCE(completed_at, ?), updated_at = ?
         WHERE id = ? AND workspace_id = ? AND external_post_id = ?
           AND status IN ('blocked', 'published')`,
      ).bind(now, now, job.id, job.workspace_id, job.external_post_id).run();
      if (resultChanges(updated) > 0) reconciled += 1;
      else errors.push({ jobId: job.id, code: "TIKTOK_MAPPING_RECONCILE_LOST" });
      continue;
    }

    await database.prepare(
      `UPDATE publish_jobs SET status = 'blocked', error_code = 'TIKTOK_MAPPING_PENDING',
       error_message = 'TikTok đã nhận sản phẩm; hệ thống đang chờ ghi liên kết nội bộ.', updated_at = ?
       WHERE id = ? AND workspace_id = ? AND external_post_id = ?
         AND status IN ('blocked', 'published')`,
    ).bind(now, job.id, job.workspace_id, job.external_post_id).run();
    errors.push({ jobId: job.id, code: "TIKTOK_MAPPING_PENDING" });
  }

  return { reconciled, errors };
}

async function markRetryOrFailed(
  database: DispatcherDatabase,
  job: CandidateJob,
  lease: LeasedAttempt,
  workerId: string,
  error: unknown,
  now: number,
) {
  const details = errorDetails(error);
  if (details.outcomeUnknown) {
    const changed = await markBlocked(
      database,
      job,
      workerId,
      details.code,
      "Kênh có thể đã nhận nội dung; cần đối soát trước khi thử lại.",
      now,
    );
    return { state: "blocked" as const, changed, code: details.code };
  }

  if (details.retryable && lease.attempt_count < lease.max_attempts) {
    const availableAt = now + retryDelayMs(lease.attempt_count);
    const result = await database.prepare(
      `UPDATE publish_jobs SET status = 'retry_wait', available_at = ?, error_code = ?, error_message = ?,
       lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'publishing' AND lease_owner = ?`,
    ).bind(
      availableAt,
      details.code,
      "Lỗi tạm thời; hệ thống sẽ tự thử lại.",
      now,
      job.id,
      job.workspace_id,
      workerId,
    ).run();
    return { state: "retrying" as const, changed: resultChanges(result) > 0, code: details.code };
  }

  const result = await database.prepare(
    `UPDATE publish_jobs SET status = 'failed', error_code = ?, error_message = ?,
     lease_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status = 'publishing' AND lease_owner = ?`,
  ).bind(
    details.code,
    "Không thể xuất bản sau số lần thử cho phép.",
    now,
    now,
    job.id,
    job.workspace_id,
    workerId,
  ).run();
  return { state: "failed" as const, changed: resultChanges(result) > 0, code: details.code };
}

async function publishLeasedJob(
  job: CandidateJob,
  publishers: DispatcherPublishers,
  workerId: string,
  database: DispatcherDatabase,
  assertLease: () => Promise<void>,
  synchronizedConnections: Set<string>,
) {
  const payload = parsePayload(job.payload_snapshot_json);
  if (job.job_kind === "social_post") {
    const copyViolation = customerCopyViolation({
      title: typeof payload.title === "string" ? payload.title : "",
      body: typeof payload.message === "string" ? payload.message : "",
      hashtags: Array.isArray(payload.hashtags) ? payload.hashtags.filter((value): value is string => typeof value === "string") : [],
    });
    if (copyViolation) throw new PublishDeliveryError(copyViolation);
  }
  if (job.draft_id && job.product_id && ["facebook", "website"].includes(job.provider)) {
    let mediaIds = Array.isArray(payload.mediaIds) ? payload.mediaIds.filter((id): id is string => typeof id === "string") : [];
    let data = payload.platformData as Record<string, unknown> | undefined;
    try {
      const sourceConnectionId = await productSourceConnection(job.product_id, database);
      if (!synchronizedConnections.has(sourceConnectionId)) {
        await syncGoogleCatalog(sourceConnectionId);
        synchronizedConnections.add(sourceConnectionId);
      }
      const sources = await productSources(job.product_id, database);
      const currentFingerprint = await productFingerprint(sources.product);
      let payloadChanged = false;
      if (data?.sourceFingerprint && data.sourceFingerprint !== currentFingerprint) {
        data = await upgradeLegacyProductPayload(database, job, payload, data, sources, currentFingerprint);
        payloadChanged = true;
      } else if (data?.sourceFingerprint === currentFingerprint
        && data.sourceFingerprintVersion !== PRODUCT_FINGERPRINT_VERSION) {
        data = { ...data, sourceFingerprintVersion: PRODUCT_FINGERPRINT_VERSION };
        payload.platformData = data;
        payloadChanged = true;
      }
      if (job.provider === "facebook") {
        // Existing daily schedules also adopt the owner's all-originals policy.
        // Refresh only before an external feed request, while this job owns its lease.
        mediaIds = sources.images.map((image) => image.id);
        data = { ...data, sourceImageCount: mediaIds.length, availableSourceImageCount: mediaIds.length,
          generatedImageCount: 0, totalImageCount: mediaIds.length };
        payload.mediaIds = mediaIds;
        payload.platformData = data;
        payloadChanged = true;
      }
      if (payloadChanged) {
        const saved = await database.prepare(`UPDATE publish_jobs SET payload_snapshot_json=?
          WHERE id=? AND workspace_id=? AND status='publishing' AND lease_owner=? AND payload_snapshot_json=? RETURNING id`)
          .bind(JSON.stringify(payload), job.id, job.workspace_id, workerId, job.payload_snapshot_json).first<{ id: string }>();
        if (!saved) throw new Error("PUBLISH_LEASE_LOST");
      }
      await assertPublishProductMedia(job.product_id, mediaIds, data ?? {}, database);
    }
    catch (error) { throw new PublishDeliveryError(error instanceof Error ? error.message : "PRODUCT_MEDIA_MISMATCH"); }
  }
  if (job.connection_status !== "connected") throw new PublishDeliveryError("CONNECTION_NOT_CONNECTED");
  if (job.publish_mode !== "api") throw new PublishDeliveryError("CONNECTION_NOT_AUTOMATIC");

  if (job.job_kind === "social_post") {
    const finalCopyViolation = customerCopyViolation({
      title: typeof payload.title === "string" ? payload.title : "",
      body: typeof payload.message === "string" ? payload.message : "",
      hashtags: Array.isArray(payload.hashtags)
        ? payload.hashtags.filter((value): value is string => typeof value === "string")
        : [],
    });
    if (finalCopyViolation) throw new PublishDeliveryError(finalCopyViolation);
  }

  if (job.provider === "facebook") {
    if (job.job_kind !== "social_post") throw new PublishDeliveryError("FACEBOOK_JOB_KIND_UNSUPPORTED");
    await assertLease();
    return publishers.facebook({ connectionId: job.connection_id, ...facebookPayload(payload), assertLease });
  }
  if (job.provider === "website") {
    return publishers.website({
      connectionId: job.connection_id,
      payload,
      idempotencyKey: job.dedupe_key,
      jobId: job.id,
    });
  }
  if (job.provider === "tiktok_shop") {
    if (job.job_kind !== "listing_upsert") throw new PublishDeliveryError("TIKTOK_JOB_KIND_UNSUPPORTED");
    if (!job.product_id) throw new PublishDeliveryError("TIKTOK_PRODUCT_ID_REQUIRED");
    return publishers.tiktokShop({
      connectionId: job.connection_id,
      jobId: job.id,
      workerId,
      productId: job.product_id,
      payload,
      progress: parsePayload(job.provider_response_json),
      externalId: job.external_post_id,
    });
  }
  if (job.provider === "shopee") {
    throw new PublishDeliveryError("COMMERCE_PUBLISH_NOT_IMPLEMENTED");
  }
  throw new PublishDeliveryError("PROVIDER_PUBLISH_NOT_SUPPORTED");
}

export async function runPublishDispatcher(options: DispatcherOptions = {}): Promise<DispatcherResult> {
  const jobIds = options.jobIds;
  if (jobIds !== undefined && (!Array.isArray(jobIds) || jobIds.length < 1 || jobIds.length > 50
    || new Set(jobIds).size !== jobIds.length
    || jobIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(id)))) {
    throw new Error("DISPATCHER_FILTER_INVALID");
  }
  const jobFilter = jobIds ? ` AND j.id IN (${jobIds.map(() => "?").join(",")})` : "";
  const dispatchStartedAt = Date.now();
  const synchronizedConnections = new Set<string>();
  const database = dispatcherDatabase(options.database);
  const publishers = options.publishers ?? defaultPublishers;
  const now = Math.floor(options.now ?? Date.now());
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  const leaseMs = Math.max(60_000, Math.floor(options.leaseMs ?? DEFAULT_LEASE_MS));
  const workerId = options.workerId ?? crypto.randomUUID();
  const recovered = await recoverExpiredLeases(database, now, jobIds);
  // A bounded dispatch must not reconcile or change unrelated TikTok receipts.
  const reconciled = jobIds ? { reconciled: 0, errors: [] }
    : await reconcileTikTokMappings(database, publishers, now, limit);
  const due = await database.prepare(
    `SELECT j.id, j.workspace_id, j.connection_id, j.product_id, j.draft_id,
            j.job_kind, j.dedupe_key,
            j.payload_snapshot_json, j.provider_response_json, j.external_post_id,
            j.external_url, j.error_code, j.attempt_count, j.max_attempts,
            c.provider, c.status AS connection_status, c.publish_mode
     FROM publish_jobs j
     JOIN channel_connections c ON c.id = j.connection_id AND c.workspace_id = j.workspace_id
     WHERE j.status IN ('queued', 'retry_wait') AND j.available_at <= ?
       AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= ?)
       ${jobFilter}
     ORDER BY j.available_at ASC, j.scheduled_for ASC, j.created_at ASC
     LIMIT ?`,
  ).bind(now, now, ...(jobIds ?? []), limit).all<CandidateJob>();

  const summary: DispatcherResult = {
    checked: 0,
    leased: 0,
    published: 0,
    retrying: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
    recoveredRetrying: recovered.retrying,
    recoveredBlocked: recovered.blocked,
    reconciledMappings: reconciled.reconciled,
    errors: [...reconciled.errors],
    dispatchedAt: now,
  };

  for (const job of due.results ?? []) {
    summary.checked += 1;
    const lease = await leaseJob(database, job, workerId, now, leaseMs);
    if (!lease) {
      summary.skipped += 1;
      continue;
    }
    summary.leased += 1;

    let accepted: RemoteResult | null = null;
    let tiktokMappingRecorded = false;
    try {
      const assertLease = async () => {
        const checkedAt = now + Date.now() - dispatchStartedAt;
        const renewed = await database.prepare(`UPDATE publish_jobs SET lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND status = 'publishing' AND lease_owner = ? AND lease_expires_at > ?
            AND EXISTS (SELECT 1 FROM channel_connections c WHERE c.id = publish_jobs.connection_id
              AND c.workspace_id = publish_jobs.workspace_id AND c.status = 'connected' AND c.publish_mode = 'api') RETURNING id`)
          .bind(checkedAt + Math.max(leaseMs, 120_000), checkedAt, job.id, job.workspace_id, workerId, checkedAt).first<{ id: string }>();
        if (!renewed) throw new PublishDeliveryError("PUBLISH_LEASE_LOST");
      };
      accepted = await publishLeasedJob(job, publishers, workerId, database, assertLease, synchronizedConnections);
      if (job.provider === "facebook") {
        const receiptSaved = await persistAcceptedReceipt(database, job, workerId, accepted, Date.now());
        if (!receiptSaved) throw new PublishDeliveryError("FACEBOOK_LOCAL_RECEIPT_PERSIST_FAILED", { outcomeUnknown: true });
      }
      if (job.provider === "tiktok_shop" && job.product_id) {
        const receiptSaved = await persistAcceptedReceipt(database, job, workerId, accepted, now);
        if (!receiptSaved) {
          throw new PublishDeliveryError("TIKTOK_LOCAL_RECEIPT_PERSIST_FAILED", { outcomeUnknown: true });
        }
        try {
          tiktokMappingRecorded = await publishers.recordTikTokShop({
            connectionId: job.connection_id,
            productId: job.product_id,
            externalId: accepted.externalId,
            providerResponse: accepted.providerResponse,
            payload: parsePayload(job.payload_snapshot_json),
          });
        } catch {
          tiktokMappingRecorded = false;
        }
        if (!tiktokMappingRecorded) {
          const changed = await markAcceptedBlocked(
            database,
            job,
            workerId,
            accepted,
            "TIKTOK_MAPPING_PENDING",
            "TikTok đã nhận sản phẩm; hệ thống đang chờ ghi liên kết nội bộ.",
            now,
          );
          if (changed) summary.blocked += 1;
          else summary.skipped += 1;
          summary.errors.push({ jobId: job.id, code: "TIKTOK_MAPPING_PENDING" });
          continue;
        }
      }
      const saved = await markPublished(database, job, workerId, accepted, now);
      if (!saved) {
        summary.blocked += 1;
        summary.errors.push({ jobId: job.id, code: "PUBLISH_LEASE_LOST" });
        continue;
      }
      summary.published += 1;
      if (job.provider === "facebook" && accepted.externalUrl) {
        try {
          await publishers.recordFacebook({
            connectionId: job.connection_id,
            jobId: job.id,
            externalId: accepted.externalId,
            externalUrl: accepted.externalUrl,
          });
        } catch {
          summary.errors.push({ jobId: job.id, code: "FACEBOOK_MAPPING_PENDING" });
        }
      }
    } catch (error) {
      if (accepted) {
        const mappingPending = job.provider === "tiktok_shop" && !tiktokMappingRecorded;
        let changed = false;
        try {
          changed = await markAcceptedBlocked(
            database,
            job,
            workerId,
            accepted,
            mappingPending ? "TIKTOK_MAPPING_PENDING" : "LOCAL_CONFIRMATION_FAILED",
            mappingPending
              ? "TikTok đã nhận sản phẩm; hệ thống đang chờ ghi liên kết nội bộ."
              : "Kênh đã nhận nội dung nhưng hệ thống chưa lưu được kết quả; cần đối soát.",
            now,
          );
        } catch {
          changed = false;
        }
        if (changed) summary.blocked += 1;
        else summary.skipped += 1;
        summary.errors.push({
          jobId: job.id,
          code: mappingPending ? "TIKTOK_MAPPING_PENDING" : "LOCAL_CONFIRMATION_FAILED",
        });
        continue;
      }
      const details = errorDetails(error);
      const shouldBlock = details.outcomeUnknown
        || details.code.startsWith("PRODUCT_") || details.code === "SKU_SOURCE_IMAGES_REQUIRED"
        || (details.code.startsWith("GOOGLE_") && !details.retryable)
        || details.code === "COMMERCE_PUBLISH_NOT_IMPLEMENTED"
        || details.code === "PROVIDER_PUBLISH_NOT_SUPPORTED"
        || details.code === "FACEBOOK_JOB_KIND_UNSUPPORTED"
        || details.code === "CONNECTION_NOT_CONNECTED"
        || details.code === "CONNECTION_NOT_AUTOMATIC"
        || isTikTokOperatorBlock(details.code);
      if (shouldBlock) {
        const changed = await markBlocked(
          database,
          job,
          workerId,
          details.code,
          details.outcomeUnknown
            ? "Kênh có thể đã nhận nội dung; cần đối soát trước khi thử lại."
            : details.code.startsWith("PRODUCT_") || details.code === "SKU_SOURCE_IMAGES_REQUIRED"
              ? "Ảnh hoặc thông tin SKU đã thay đổi. Đồng bộ lại và xác nhận sản phẩm để tạo bài mới."
              : "Kênh hoặc loại công việc này chưa thể tự xuất bản.",
          now,
        );
        if (changed) summary.blocked += 1;
        else summary.skipped += 1;
        summary.errors.push({ jobId: job.id, code: details.code });
        continue;
      }

      const transition = await markRetryOrFailed(database, job, lease, workerId, error, now);
      if (transition.changed) summary[transition.state] += 1;
      else summary.skipped += 1;
      summary.errors.push({ jobId: job.id, code: transition.code });
    }
  }

  return summary;
}
