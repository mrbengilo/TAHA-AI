import { activateSchedule, createSchedule } from "./schedules";
import {
  FACEBOOK_PLAN_TIMEZONE,
  FacebookPublishingPlanError,
  listFacebookPublishingPlans,
  vietnamTimestamp,
} from "./facebook-publishing-plans";
import { getRuntimeEnv } from "./integrations/env";
import { TAHA_WORKSPACE_ID } from "./integrations/store";

type Statement = {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results?: T[] }>;
};

type RepostProductRow = {
  id: string;
  base_sku: string;
  name: string;
  last_published_at: number;
};

type ReusableDraftRow = {
  draft_id: string;
  source_job_id: string;
};

function database() {
  const value = getRuntimeEnv().DB as unknown as { prepare(query: string): Statement } | undefined;
  if (!value) throw new FacebookPublishingPlanError("DATABASE_UNAVAILABLE", "Cơ sở dữ liệu đăng lại chưa sẵn sàng.", 503);
  return value;
}

function objectValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FacebookPublishingPlanError("INVALID_REQUEST", "Dữ liệu đăng lại Facebook không hợp lệ.", 422);
  }
  return value as Record<string, unknown>;
}

function requiredProductId(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 120) {
    throw new FacebookPublishingPlanError("INVALID_PRODUCT", "Sản phẩm đăng lại không hợp lệ.", 422);
  }
  return value.trim();
}

export async function listFacebookRepostProducts() {
  const connection = await listFacebookPublishingPlans();
  const rows = await database().prepare(
    `SELECT p.id, p.base_sku, p.name, MAX(j.completed_at) AS last_published_at
     FROM publish_jobs j
     JOIN channel_connections published_connection
       ON published_connection.id = j.connection_id AND published_connection.workspace_id = j.workspace_id
     JOIN products p ON p.id = j.product_id AND p.workspace_id = j.workspace_id
     WHERE j.workspace_id = ? AND j.status = 'published' AND j.external_post_id IS NOT NULL
       AND published_connection.provider = 'facebook' AND p.deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM content_drafts reusable
         WHERE reusable.id = j.draft_id AND reusable.workspace_id = j.workspace_id
           AND reusable.product_id = p.id AND reusable.target_provider = 'facebook'
           AND reusable.status = 'approved' AND reusable.archived_at IS NULL
           AND EXISTS (
             SELECT 1 FROM content_draft_media cdm JOIN media_assets m
               ON m.id = cdm.media_id AND m.workspace_id = cdm.workspace_id
             WHERE cdm.workspace_id = reusable.workspace_id AND cdm.draft_id = reusable.id
               AND m.status = 'ready'
           )
           AND NOT EXISTS (
             SELECT 1 FROM content_draft_media cdm JOIN media_assets m
               ON m.id = cdm.media_id AND m.workspace_id = cdm.workspace_id
             WHERE cdm.workspace_id = reusable.workspace_id AND cdm.draft_id = reusable.id
               AND m.status != 'ready'
           )
       )
     GROUP BY p.id, p.base_sku, p.name
     ORDER BY last_published_at DESC, p.base_sku ASC
     LIMIT 200`,
  ).bind(TAHA_WORKSPACE_ID).all<RepostProductRow>();
  return {
    connectionId: connection.connectionId,
    timezone: FACEBOOK_PLAN_TIMEZONE,
    products: (rows.results ?? []).map((row) => ({
      id: row.id,
      sku: row.base_sku,
      name: row.name,
      lastPublishedAt: row.last_published_at,
    })),
  };
}

export async function scheduleFacebookRepost(value: unknown, actorId: string | null, now = Date.now()) {
  const body = objectValue(value);
  const productId = requiredProductId(body.productId);
  const date = typeof body.date === "string" ? body.date : "";
  const time = typeof body.time === "string" ? body.time : "";
  const scheduledFor = vietnamTimestamp(date, time);
  if (scheduledFor <= now) {
    throw new FacebookPublishingPlanError("SCHEDULE_IN_PAST", "Ngày và giờ đăng lại phải ở tương lai.", 422);
  }
  const connection = await listFacebookPublishingPlans();
  const reusable = await database().prepare(
    `SELECT d.id AS draft_id, j.id AS source_job_id
     FROM publish_jobs j
     JOIN channel_connections c ON c.id = j.connection_id AND c.workspace_id = j.workspace_id
     JOIN content_drafts d ON d.id = j.draft_id AND d.workspace_id = j.workspace_id
     WHERE j.workspace_id = ? AND j.product_id = ? AND j.status = 'published'
       AND j.external_post_id IS NOT NULL AND c.provider = 'facebook'
       AND d.product_id = ? AND d.target_provider = 'facebook' AND d.status = 'approved' AND d.archived_at IS NULL
       AND EXISTS (
         SELECT 1 FROM content_draft_media cdm JOIN media_assets m
           ON m.id = cdm.media_id AND m.workspace_id = cdm.workspace_id
         WHERE cdm.workspace_id = d.workspace_id AND cdm.draft_id = d.id AND m.status = 'ready'
       )
       AND NOT EXISTS (
         SELECT 1 FROM content_draft_media cdm JOIN media_assets m
           ON m.id = cdm.media_id AND m.workspace_id = cdm.workspace_id
         WHERE cdm.workspace_id = d.workspace_id AND cdm.draft_id = d.id AND m.status != 'ready'
       )
     ORDER BY j.completed_at DESC, j.created_at DESC LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID, productId, productId).first<ReusableDraftRow>();
  if (!reusable) {
    throw new FacebookPublishingPlanError(
      "FACEBOOK_REPOST_SOURCE_REQUIRED",
      "Chỉ có thể đăng lại sản phẩm đã đăng Facebook thành công và còn đủ nội dung, hình ảnh.",
      409,
    );
  }

  const replay = await database().prepare(
    `SELECT id, status FROM schedules
     WHERE workspace_id = ? AND connection_id = ? AND run_at = ?
       AND json_extract(publish_options_json, '$.repostProductId') = ?
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID, connection.connectionId, scheduledFor, productId)
    .first<{ id: string; status: string }>();
  if (replay) return { scheduleId: replay.id, status: replay.status, replayed: true, productId, scheduledFor };

  if (connection.plans.some((plan) => plan.date === date && plan.times.includes(time))) {
    throw new FacebookPublishingPlanError(
      "FACEBOOK_TIME_COLLISION",
      "Khung giờ này thuộc lịch tự động theo ngày. Hãy chọn giờ đăng lại khác.",
      409,
    );
  }

  const collision = await database().prepare(
    `SELECT id FROM schedules
     WHERE workspace_id = ? AND connection_id = ? AND run_at = ? AND status IN ('draft','active') LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID, connection.connectionId, scheduledFor).first<{ id: string }>();
  if (collision) {
    throw new FacebookPublishingPlanError(
      "FACEBOOK_TIME_COLLISION",
      "Khung giờ này đã có một bài Facebook khác. Hãy chọn giờ khác.",
      409,
    );
  }

  const created = await createSchedule({
    idempotencyKey: `facebook-repost:${productId}:${scheduledFor}`,
    draftId: reusable.draft_id,
    connectionId: connection.connectionId,
    scheduleKind: "once",
    runAt: scheduledFor,
    localTime: null,
    weekdays: [],
    timezone: FACEBOOK_PLAN_TIMEZONE,
    endsAt: null,
    executionMode: "auto",
    publishOptions: {
      repost: true,
      repostProductId: productId,
      sourcePublishJobId: reusable.source_job_id,
    },
  }, actorId, now);
  const activated = await activateSchedule(created.schedule.id, now);
  return {
    scheduleId: activated.schedule.id,
    status: activated.schedule.status,
    replayed: created.replay || activated.replay,
    productId,
    scheduledFor,
  };
}
