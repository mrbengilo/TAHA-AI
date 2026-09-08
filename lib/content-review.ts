import { getRuntimeEnv } from "./integrations/env";
import { TAHA_WORKSPACE_ID } from "./integrations/store";
import { objectJson } from "./product-integrity";
import { assertPublishProductMedia } from "./publish-media-integrity";
import { customerCopyViolation } from "./ai/shoe-content";

export class ContentReviewError extends Error {
  constructor(public code: string, public userMessage: string, public status = 409) { super(code); }
}

const retryableFacebookContentErrors = new Set([
  "CONTENT_PRICE_FORBIDDEN",
  "CONTENT_INTERNAL_TEXT_FORBIDDEN",
  "CONTENT_WORD_LIMIT_EXCEEDED",
]);

type ExistingPublishJob = {
  id: string;
  status: string;
  error_code: string | null;
  external_post_id: string | null;
  external_url: string | null;
  provider_response_json: string;
};

function hasProviderReceipt(value: string) {
  try {
    const response = JSON.parse(value) as unknown;
    return !response || typeof response !== "object" || Array.isArray(response) || Object.keys(response).length > 0;
  } catch {
    return true;
  }
}

export async function reviewContentDraft(id: string, input: Record<string, unknown>, actor: string) {
  const db = getRuntimeEnv().DB;
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  if (!Number.isInteger(input.version) || Number(input.version) < 1 || !["edit", "reject"].includes(String(input.action))) {
    throw new ContentReviewError("INVALID_REVIEW", "Thiếu phiên bản bài viết hoặc thao tác hợp lệ.", 422);
  }
  const reject = input.action === "reject";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const hashtags = Array.isArray(input.hashtags) ? [...new Set(input.hashtags.map((v) => String(v).trim().replace(/^#+/, "")))].filter(Boolean) : [];
  if (!reject && (!body || body.length > 20000 || title.length > 180 || !hashtags.length || hashtags.length > 20 || hashtags.some((v) => !/^[^\s#]{1,79}$/.test(v)))) {
    throw new ContentReviewError("INVALID_CONTENT", "Nhập bài viết và hashtag không chứa khoảng trắng.", 422);
  }
  if (!reject) {
    const violation = customerCopyViolation({ title, body, hashtags });
    if (violation) throw new ContentReviewError(violation,
      violation === "CONTENT_PRICE_FORBIDDEN" ? "Bài viết không được chứa giá hoặc thông tin báo giá."
        : violation === "CONTENT_WORD_LIMIT_EXCEEDED" ? "Bài viết tối đa 2.000 từ, tính cả tiêu đề và hashtag."
          : "Bỏ thông tin về quy trình nội bộ và lời nhắc kiểm tra mã sản phẩm khỏi bài viết.", 422);
  }
  const now = Date.now();
  const reviewId = crypto.randomUUID();
  const guard = `EXISTS (SELECT 1 FROM content_drafts d WHERE d.id = ? AND d.workspace_id = ?
    AND json_extract(d.generation_meta_json, '$.lastReviewId') = ?)`;
  const mutation = db.prepare(`UPDATE content_drafts SET
    title = CASE WHEN ? THEN title ELSE ? END, body = CASE WHEN ? THEN body ELSE ? END,
    hashtags_json = CASE WHEN ? THEN hashtags_json ELSE ? END,
    status = CASE WHEN ? THEN 'rejected' ELSE status END,
    rejection_reason = CASE WHEN ? THEN 'Admin không cho đăng' ELSE NULL END,
    version = version + 1, updated_at = ?, generation_meta_json = json_set(generation_meta_json, '$.lastReviewId', ?)
    WHERE id = ? AND workspace_id = ? AND version = ? AND status IN ('approved', 'draft', 'in_review')
      AND NOT EXISTS (SELECT 1 FROM publish_jobs j WHERE j.draft_id = content_drafts.id
        AND j.workspace_id = content_drafts.workspace_id
        AND (j.status IN ('publishing', 'published') OR j.external_post_id IS NOT NULL
          OR (j.status = 'blocked' AND (j.error_code LIKE '%UNKNOWN%' OR j.error_code LIKE '%PERSIST%' OR j.error_code LIKE '%MAPPING%'))))`)
    .bind(reject ? 1 : 0, title, reject ? 1 : 0, body, reject ? 1 : 0, JSON.stringify(hashtags), reject ? 1 : 0, reject ? 1 : 0,
      now, reviewId, id, TAHA_WORKSPACE_ID, input.version);
  const statements = [mutation];
  if (reject) {
    statements.push(db.prepare(`UPDATE schedules SET status = 'paused', next_run_at = NULL, updated_at = ?
      WHERE draft_id = ? AND workspace_id = ? AND ${guard}`).bind(now, id, TAHA_WORKSPACE_ID, id, TAHA_WORKSPACE_ID, reviewId));
    statements.push(db.prepare(`UPDATE publish_jobs SET status = 'cancelled', completed_at = ?, updated_at = ?,
      lease_owner = NULL, lease_expires_at = NULL, error_code = 'ADMIN_REJECTED', error_message = 'Admin không cho đăng.'
      WHERE draft_id = ? AND workspace_id = ? AND status IN ('queued', 'retry_wait', 'blocked', 'awaiting_confirmation') AND ${guard}`)
      .bind(now, now, id, TAHA_WORKSPACE_ID, id, TAHA_WORKSPACE_ID, reviewId));
  } else {
    statements.push(db.prepare(`UPDATE publish_jobs SET payload_snapshot_json = json_set(payload_snapshot_json,
      '$.title', ?, '$.message', ?, '$.hashtags', json(?), '$.draftVersion', ?), updated_at = ?
      WHERE draft_id = ? AND workspace_id = ? AND status IN ('queued', 'retry_wait', 'awaiting_confirmation') AND ${guard}`)
      .bind(title, body, JSON.stringify(hashtags), Number(input.version) + 1, now, id, TAHA_WORKSPACE_ID, id, TAHA_WORKSPACE_ID, reviewId));
  }
  statements.push(db.prepare(`INSERT INTO audit_logs (id, workspace_id, actor_type, actor_id, actor_label,
    action, entity_type, entity_id, metadata_json, created_at)
    SELECT ?, ?, 'user', ?, 'Admin', ?, 'content_draft', ?, ?, ? WHERE ${guard}`)
    .bind(reviewId, TAHA_WORKSPACE_ID, actor, reject ? "content.rejected" : "content.edited", id,
      JSON.stringify({ version: Number(input.version) + 1 }), now, id, TAHA_WORKSPACE_ID, reviewId));
  const result = await db.batch(statements);
  if (!result[0].meta.changes) throw new ContentReviewError("CONTENT_REVIEW_CONFLICT", "Bài đã thay đổi, đang gửi hoặc đã đăng. Hãy tải lại để kiểm tra trạng thái.");
  return { id, version: Number(input.version) + 1, rejected: reject };
}

export async function approvedDraftPayload(id: string, provider: string) {
  const db = getRuntimeEnv().DB;
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  const draft = await db.prepare(`SELECT id, product_id, body, title, hashtags_json, platform_data_json, version
    FROM content_drafts WHERE id = ? AND workspace_id = ? AND target_provider = ? AND status = 'approved' LIMIT 1`)
    .bind(id, TAHA_WORKSPACE_ID, provider).first<{ id: string; product_id: string; body: string; title: string; hashtags_json: string; platform_data_json: string; version: number }>();
  if (!draft) throw new ContentReviewError("DRAFT_NOT_APPROVED", "Bài viết chưa được cho phép đăng hoặc đã bị admin chặn.");
  const violation = customerCopyViolation({ title: draft.title, body: draft.body, hashtags: JSON.parse(draft.hashtags_json) });
  if (violation) throw new ContentReviewError(violation, "Bài viết cần bỏ giá, thông tin nội bộ và bảo đảm tối đa 2.000 từ trước khi đăng.", 422);
  const media = await db.prepare(`SELECT media_id FROM content_draft_media WHERE draft_id = ? AND workspace_id = ? ORDER BY sort_order, created_at`)
    .bind(id, TAHA_WORKSPACE_ID).all<{ media_id: string }>();
  const mediaIds = media.results.map((item) => item.media_id);
  const data = objectJson(draft.platform_data_json);
  await assertPublishProductMedia(draft.product_id, mediaIds, data);
  return { draft, mediaIds, platformData: data };
}

export async function scheduleReviewedDraft(draftId: string, connectionId: string, provider: string) {
  const db = getRuntimeEnv().DB!;
  const { draft, mediaIds, platformData } = await approvedDraftPayload(draftId, provider);
  const connection = await db.prepare("SELECT id FROM channel_connections WHERE id = ? AND workspace_id = ? AND provider = ? AND status = 'connected'")
    .bind(connectionId, TAHA_WORKSPACE_ID, provider).first();
  if (!connection) throw new ContentReviewError("CONNECTION_NOT_FOUND", "Tài khoản đích chưa kết nối.");
  const existing = await db.prepare("SELECT id, status FROM schedules WHERE draft_id = ? AND connection_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(draftId, connectionId, TAHA_WORKSPACE_ID).first<{ id: string; status: string }>();
  if (existing) {
    if (provider !== "facebook") return { scheduleId: existing.id, status: existing.status, replayed: true };
    const job = await db.prepare(`SELECT id, status, error_code, external_post_id, external_url, provider_response_json
      FROM publish_jobs WHERE schedule_id = ? AND draft_id = ? AND connection_id = ? AND workspace_id = ?
      ORDER BY created_at DESC LIMIT 1`)
      .bind(existing.id, draftId, connectionId, TAHA_WORKSPACE_ID).first<ExistingPublishJob>();
    if (!job) {
      return { scheduleId: existing.id, status: existing.status, replayed: true };
    }
    if (job.status === "blocked") {
      throw new ContentReviewError("FACEBOOK_RETRY_REQUIRES_RECONCILIATION",
        "Chưa xác định Facebook đã nhận bài hay chưa. Hãy đối soát kênh trước khi thử lại để tránh đăng trùng.");
    }
    if (job.status !== "failed") {
      return { scheduleId: existing.id, status: job.status, replayed: true };
    }
    if (job.external_post_id || job.external_url || hasProviderReceipt(job.provider_response_json)) {
      throw new ContentReviewError("FACEBOOK_RETRY_REQUIRES_RECONCILIATION",
        "Lần đăng này có dấu hiệu kênh đã nhận bài. Hãy đối soát Facebook trước khi thử lại để tránh đăng trùng.");
    }
    if (!retryableFacebookContentErrors.has(job.error_code ?? "")) {
      throw new ContentReviewError("FACEBOOK_RETRY_NOT_ALLOWED",
        "Lần đăng này không thất bại do nội dung. Hãy kiểm tra lỗi trong lịch sử trước khi thử lại.");
    }
    const competing = await db.prepare(`SELECT id FROM publish_jobs
      WHERE draft_id = ? AND connection_id = ? AND workspace_id = ? AND id <> ?
        AND (status IN ('queued', 'retry_wait', 'awaiting_confirmation', 'publishing', 'published', 'blocked')
          OR external_post_id IS NOT NULL OR external_url IS NOT NULL OR provider_response_json <> '{}')
      LIMIT 1`)
      .bind(draftId, connectionId, TAHA_WORKSPACE_ID, job.id).first<{ id: string }>();
    if (competing) {
      throw new ContentReviewError("FACEBOOK_RETRY_REQUIRES_RECONCILIATION",
        "Bài viết đã có một lần đăng khác đang chạy hoặc có kết quả. Hãy đối soát Facebook trước khi thử lại để tránh đăng trùng.");
    }
    const now = Date.now();
    const queued = await db.prepare(`UPDATE publish_jobs SET
      payload_snapshot_json = json_set(payload_snapshot_json,
        '$.title', ?, '$.message', ?, '$.hashtags', json(?), '$.draftVersion', ?,
        '$.mediaIds', json(?), '$.platformData', json(?)),
      status = 'queued', available_at = ?, attempt_count = 0,
      lease_owner = NULL, lease_expires_at = NULL, started_at = NULL, completed_at = NULL,
      error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND schedule_id = ? AND draft_id = ? AND connection_id = ?
        AND status = 'failed' AND error_code IN ('CONTENT_PRICE_FORBIDDEN', 'CONTENT_INTERNAL_TEXT_FORBIDDEN', 'CONTENT_WORD_LIMIT_EXCEEDED')
        AND external_post_id IS NULL AND external_url IS NULL
        AND json_valid(provider_response_json) AND json_type(provider_response_json) = 'object'
        AND NOT EXISTS (SELECT 1 FROM json_each(provider_response_json))
        AND EXISTS (SELECT 1 FROM content_drafts d WHERE d.id = publish_jobs.draft_id
          AND d.workspace_id = publish_jobs.workspace_id AND d.status = 'approved' AND d.version = ?)
        AND NOT EXISTS (SELECT 1 FROM publish_jobs other
          WHERE other.draft_id = publish_jobs.draft_id AND other.connection_id = publish_jobs.connection_id
            AND other.workspace_id = publish_jobs.workspace_id AND other.id <> publish_jobs.id
            AND (other.status IN ('queued', 'retry_wait', 'awaiting_confirmation', 'publishing', 'published', 'blocked')
              OR other.external_post_id IS NOT NULL OR other.external_url IS NOT NULL OR other.provider_response_json <> '{}'))
        AND COALESCE((SELECT json_group_array(media_id) FROM
          (SELECT media_id FROM content_draft_media WHERE draft_id = ? AND workspace_id = ? ORDER BY sort_order, created_at)), '[]') = json(?)
      RETURNING id`)
      .bind(draft.title, draft.body, draft.hashtags_json, draft.version,
        JSON.stringify(mediaIds), JSON.stringify(platformData), now, now,
        job.id, TAHA_WORKSPACE_ID, existing.id, draftId, connectionId,
        draft.version, draftId, TAHA_WORKSPACE_ID, JSON.stringify(mediaIds))
      .first<{ id: string }>();
    if (queued) return { scheduleId: existing.id, status: "queued", replayed: false };

    const raced = await db.prepare(`SELECT status, error_code, external_post_id, external_url, provider_response_json
      FROM publish_jobs WHERE id = ? AND workspace_id = ? LIMIT 1`)
      .bind(job.id, TAHA_WORKSPACE_ID).first<ExistingPublishJob>();
    if (raced && ["queued", "retry_wait", "publishing", "published"].includes(raced.status)) {
      return { scheduleId: existing.id, status: raced.status, replayed: true };
    }
    throw new ContentReviewError("CONTENT_REVIEW_CONFLICT",
      "Bài viết, ảnh hoặc trạng thái đăng đã thay đổi. Hãy tải lại trước khi thử lại.");
  }
  const id = `manual:${draftId}:${connectionId}`;
  const now = Date.now();
  const result = await db.prepare(`INSERT INTO schedules (id, workspace_id, draft_id, connection_id, status,
    schedule_kind, run_at, next_run_at, timezone, execution_mode, created_by, created_at, updated_at)
    SELECT ?, ?, ?, ?, 'active', 'once', ?, ?, 'Asia/Ho_Chi_Minh', ?, 'operator', ?, ?
    WHERE EXISTS (SELECT 1 FROM content_drafts WHERE id = ? AND workspace_id = ? AND status = 'approved' AND version = ?)
    ON CONFLICT(id) DO NOTHING`).bind(id, TAHA_WORKSPACE_ID, draftId, connectionId, now + 5 * 60_000, now + 5 * 60_000,
      provider === "zalo_personal" ? "assisted" : "auto", now, now, draftId, TAHA_WORKSPACE_ID, draft.version).run();
  if (!result.meta.changes) throw new ContentReviewError("CONTENT_REVIEW_CONFLICT", "Bài đã thay đổi; hãy tải lại.");
  return { scheduleId: id, status: "active", replayed: false };
}
