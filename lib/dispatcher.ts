import { getRuntimeEnv } from "./integrations/env";
import {
  PublishDeliveryError,
  recordFacebookMapping,
  sendFacebookPost,
  sendWebsitePayload,
} from "./publishing";
import { recordTikTokShopMappings, sendTikTokShopListing } from "./tiktok-shop-publishing";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_LEASE_MS = 10 * 60 * 1_000;
const MAX_BACKOFF_MS = 15 * 60 * 1_000;

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
  facebook(input: { connectionId: string; message: string; mediaIds: string[] }): Promise<RemoteResult>;
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
    productId: string;
    payload: Record<string, unknown>;
  }): Promise<RemoteResult>;
  recordTikTokShop(input: {
    connectionId: string;
    productId: string;
    externalId: string;
    providerResponse: Record<string, unknown>;
  }): Promise<boolean>;
};

export type DispatcherOptions = {
  database?: DispatcherDatabase;
  publishers?: DispatcherPublishers;
  now?: number;
  limit?: number;
  leaseMs?: number;
  workerId?: string;
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

function facebookPayload(payload: Record<string, unknown>) {
  const message = typeof payload.message === "string" ? payload.message : "";
  const hashtags = Array.isArray(payload.hashtags)
    ? payload.hashtags
      .filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value: string) => `#${value.trim().replace(/^#+/, "")}`)
    : [];
  const mediaIds = Array.isArray(payload.mediaIds)
    ? payload.mediaIds.filter((value: unknown): value is string => typeof value === "string").slice(0, 10)
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
      retryable: error.retryable,
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
    retryable: typeof shaped?.retryable === "boolean" ? shaped.retryable : !blocked,
    outcomeUnknown: shaped?.outcomeUnknown === true,
  };
}

function isTikTokOperatorBlock(code: string) {
  return code === "TIKTOK_JOB_KIND_UNSUPPORTED"
    || code === "TIKTOK_PRODUCT_ID_REQUIRED"
    || code === "TIKTOK_PRODUCT_NOT_FOUND"
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
    || code === "TIKTOK_PRODUCT_UPDATE_REQUIRES_REMOTE_SNAPSHOT";
}

async function recoverExpiredLeases(database: DispatcherDatabase, now: number) {
  const website = await database.prepare(
    `UPDATE publish_jobs SET status = 'retry_wait', available_at = ?, lease_owner = NULL,
     lease_expires_at = NULL, error_code = 'LEASE_EXPIRED_RETRY',
     error_message = 'Worker dừng giữa lần gửi; website sẽ chống trùng bằng idempotency key.', updated_at = ?
     WHERE status = 'publishing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
       AND connection_id IN (SELECT id FROM channel_connections WHERE provider = 'website')`,
  ).bind(now, now, now).run();
  const uncertain = await database.prepare(
    `UPDATE publish_jobs SET status = 'blocked', lease_owner = NULL, lease_expires_at = NULL,
     error_code = 'DELIVERY_OUTCOME_UNKNOWN',
     error_message = 'Worker dừng sau khi bắt đầu gửi; cần đối soát kênh trước khi thử lại.', updated_at = ?
     WHERE status = 'publishing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
  ).bind(now, now).run();
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
     WHERE id = ? AND workspace_id = ? AND status = 'publishing' AND lease_owner = ?
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
) {
  const payload = parsePayload(job.payload_snapshot_json);
  if (job.connection_status !== "connected") throw new PublishDeliveryError("CONNECTION_NOT_CONNECTED");
  if (job.publish_mode !== "api") throw new PublishDeliveryError("CONNECTION_NOT_AUTOMATIC");

  if (job.provider === "facebook") {
    if (job.job_kind !== "social_post") throw new PublishDeliveryError("FACEBOOK_JOB_KIND_UNSUPPORTED");
    return publishers.facebook({ connectionId: job.connection_id, ...facebookPayload(payload) });
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
      productId: job.product_id,
      payload,
    });
  }
  if (job.provider === "shopee") {
    throw new PublishDeliveryError("COMMERCE_PUBLISH_NOT_IMPLEMENTED");
  }
  throw new PublishDeliveryError("PROVIDER_PUBLISH_NOT_SUPPORTED");
}

export async function runPublishDispatcher(options: DispatcherOptions = {}): Promise<DispatcherResult> {
  const database = dispatcherDatabase(options.database);
  const publishers = options.publishers ?? defaultPublishers;
  const now = Math.floor(options.now ?? Date.now());
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  const leaseMs = Math.max(60_000, Math.floor(options.leaseMs ?? DEFAULT_LEASE_MS));
  const workerId = options.workerId ?? crypto.randomUUID();
  const recovered = await recoverExpiredLeases(database, now);
  const due = await database.prepare(
    `SELECT j.id, j.workspace_id, j.connection_id, j.product_id, j.draft_id,
            j.job_kind, j.dedupe_key,
            j.payload_snapshot_json, j.attempt_count, j.max_attempts,
            c.provider, c.status AS connection_status, c.publish_mode
     FROM publish_jobs j
     JOIN channel_connections c ON c.id = j.connection_id AND c.workspace_id = j.workspace_id
     WHERE j.status IN ('queued', 'retry_wait') AND j.available_at <= ?
       AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= ?)
     ORDER BY j.available_at ASC, j.scheduled_for ASC, j.created_at ASC
     LIMIT ?`,
  ).bind(now, now, limit).all<CandidateJob>();

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
    errors: [],
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
    try {
      accepted = await publishLeasedJob(job, publishers);
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
      if (job.provider === "tiktok_shop" && job.product_id) {
        try {
          const recorded = await publishers.recordTikTokShop({
            connectionId: job.connection_id,
            productId: job.product_id,
            externalId: accepted.externalId,
            providerResponse: accepted.providerResponse,
          });
          if (!recorded) summary.errors.push({ jobId: job.id, code: "TIKTOK_MAPPING_PENDING" });
        } catch {
          summary.errors.push({ jobId: job.id, code: "TIKTOK_MAPPING_PENDING" });
        }
      }
    } catch (error) {
      if (accepted) {
        const changed = await markBlocked(
          database,
          job,
          workerId,
          "LOCAL_CONFIRMATION_FAILED",
          "Kênh đã nhận nội dung nhưng hệ thống chưa lưu được kết quả; cần đối soát.",
          now,
        );
        if (changed) summary.blocked += 1;
        else summary.skipped += 1;
        summary.errors.push({ jobId: job.id, code: "LOCAL_CONFIRMATION_FAILED" });
        continue;
      }
      const details = errorDetails(error);
      const shouldBlock = details.outcomeUnknown
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
