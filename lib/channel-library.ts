import { getRuntimeEnv } from "./integrations/env";
import { ensureWorkspace, TAHA_WORKSPACE_ID } from "./integrations/store";

export const channelIds = [
  "google_drive",
  "google_sheets",
  "facebook",
  "zalo_personal",
  "tiktok_shop",
  "shopee",
  "website",
] as const;

export type ChannelId = (typeof channelIds)[number];

export const mediaImportTargetIds = ["facebook", "zalo_personal", "tiktok_shop", "shopee", "website"] as const;
export type MediaImportTargetId = (typeof mediaImportTargetIds)[number];

type ConnectionProvider = "google" | "facebook" | "zalo_personal" | "tiktok_shop" | "shopee" | "website";
type DraftContentType = "social_post" | "product_listing" | "short_video_caption" | "website_article";

type ChannelDefinition = {
  id: ChannelId;
  name: string;
  description: string;
  connectionProvider: ConnectionProvider;
  defaultContentType: DraftContentType;
  contentTypes: readonly DraftContentType[];
  actions: readonly string[];
  connectHref: string | null;
};

export const channelDefinitions: Record<ChannelId, ChannelDefinition> = {
  google_drive: {
    id: "google_drive",
    name: "Google Drive",
    description: "Kho ảnh nguồn và tệp sản phẩm đồng bộ từ Google Drive.",
    connectionProvider: "google",
    defaultContentType: "website_article",
    contentTypes: ["website_article"],
    actions: ["connect", "sync", "upload", "create_draft"],
    connectHref: "/api/integrations/google/connect",
  },
  google_sheets: {
    id: "google_sheets",
    name: "Google Sheets",
    description: "Dữ liệu sản phẩm và nội dung được quản lý từ Google Sheets.",
    connectionProvider: "google",
    defaultContentType: "product_listing",
    contentTypes: ["product_listing", "website_article"],
    actions: ["connect", "sync", "upload", "create_draft"],
    connectHref: "/api/integrations/google/connect",
  },
  facebook: {
    id: "facebook",
    name: "Facebook Page",
    description: "Ảnh và bài viết dành riêng cho Facebook Page.",
    connectionProvider: "facebook",
    defaultContentType: "social_post",
    contentTypes: ["social_post"],
    actions: ["connect", "upload", "create_draft", "schedule", "publish"],
    connectHref: "/api/integrations/facebook/connect",
  },
  zalo_personal: {
    id: "zalo_personal",
    name: "Zalo cá nhân",
    description: "Ảnh và nội dung chuẩn bị sẵn để chủ tài khoản xác nhận đăng.",
    connectionProvider: "zalo_personal",
    defaultContentType: "social_post",
    contentTypes: ["social_post"],
    actions: ["upload", "create_draft", "prepare", "confirm"],
    connectHref: null,
  },
  tiktok_shop: {
    id: "tiktok_shop",
    name: "TikTok Shop",
    description: "Video, ảnh, caption và nội dung listing dành cho TikTok Shop.",
    connectionProvider: "tiktok_shop",
    defaultContentType: "short_video_caption",
    contentTypes: ["short_video_caption", "product_listing"],
    actions: ["connect", "upload", "create_draft"],
    connectHref: "/api/integrations/tiktok-shop/connect",
  },
  shopee: {
    id: "shopee",
    name: "Shopee",
    description: "Ảnh và nội dung listing dành riêng cho gian hàng Shopee.",
    connectionProvider: "shopee",
    defaultContentType: "product_listing",
    contentTypes: ["product_listing"],
    actions: ["connect", "upload", "create_draft"],
    connectHref: "/api/integrations/shopee/connect",
  },
  website: {
    id: "website",
    name: "Website",
    description: "Ảnh, bài viết và nội dung sản phẩm dành cho website bán hàng.",
    connectionProvider: "website",
    defaultContentType: "website_article",
    contentTypes: ["website_article", "product_listing"],
    actions: ["configure", "upload", "create_draft", "schedule", "publish"],
    connectHref: null,
  },
};

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_UPLOAD_REQUEST_BYTES = MAX_VIDEO_BYTES + 1024 * 1024;

const mimeDefinitions = {
  "image/jpeg": { mediaType: "image", extension: "jpg", maxBytes: MAX_IMAGE_BYTES },
  "image/png": { mediaType: "image", extension: "png", maxBytes: MAX_IMAGE_BYTES },
  "image/webp": { mediaType: "image", extension: "webp", maxBytes: MAX_IMAGE_BYTES },
  "image/gif": { mediaType: "image", extension: "gif", maxBytes: MAX_IMAGE_BYTES },
  "video/mp4": { mediaType: "video", extension: "mp4", maxBytes: MAX_VIDEO_BYTES },
  "video/webm": { mediaType: "video", extension: "webm", maxBytes: MAX_VIDEO_BYTES },
  "video/quicktime": { mediaType: "video", extension: "mov", maxBytes: MAX_VIDEO_BYTES },
} as const;

type AllowedMimeType = keyof typeof mimeDefinitions;

export class ChannelLibraryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "ChannelLibraryError";
  }
}

export function isChannelId(value: string): value is ChannelId {
  return channelIds.includes(value as ChannelId);
}

export function requireChannelId(value: string) {
  if (!isChannelId(value)) {
    throw new ChannelLibraryError("CHANNEL_NOT_FOUND", "Kênh lưu trữ không hợp lệ.", 404);
  }
  return value;
}

export function normalizeListLimit(value: string | null) {
  if (!value) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ChannelLibraryError("INVALID_LIMIT", "Giới hạn danh sách phải là số nguyên dương.");
  }
  return Math.min(parsed, 100);
}

function database() {
  const value = getRuntimeEnv().DB;
  if (!value) throw new ChannelLibraryError("DATABASE_UNAVAILABLE", "Kho dữ liệu chưa sẵn sàng.", 503);
  return value;
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asNullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asIso(value: unknown) {
  const number = asNullableNumber(value);
  return number === null ? null : new Date(number).toISOString();
}

function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function maxTimestamp(...values: unknown[]) {
  const timestamps = values.map(asNullableNumber).filter((value): value is number => value !== null);
  return timestamps.length ? Math.max(...timestamps) : null;
}

type AggregateRow = { channel_id: string | null; total?: unknown; queued_count?: unknown; published_count?: unknown; last_activity_at?: unknown };
type ConnectionRow = {
  id: string;
  provider: ConnectionProvider;
  display_name: string;
  external_account_id: string | null;
  status: string;
  publish_mode: string;
  last_synced_at: number | null;
  last_error: string | null;
  updated_at: number;
};

function rows<T>(result: D1Result<T>) {
  return result.results ?? [];
}

function aggregateMap(result: D1Result<AggregateRow>) {
  return new Map(rows(result).filter((row) => isChannelId(row.channel_id ?? "")).map((row) => [row.channel_id as ChannelId, row]));
}

export async function listChannelSummaries() {
  const db = database();
  const [connectionsResult, mediaResult, draftsResult, jobsResult, productsResult] = await Promise.all([
    db.prepare(
      `SELECT id, provider, display_name, external_account_id, status, publish_mode,
              last_synced_at, last_error, updated_at
       FROM channel_connections
       WHERE workspace_id = ?
       ORDER BY created_at ASC`,
    ).bind(TAHA_WORKSPACE_ID).all<ConnectionRow>(),
    db.prepare(
      `WITH memberships AS (
         SELECT id AS media_id,
                COALESCE(channel_id, CASE WHEN storage_provider IN ('google_drive', 'r2') THEN 'google_drive' END) AS channel_id,
                updated_at AS activity_at
         FROM media_assets
         WHERE workspace_id = ? AND status != 'archived'
         UNION ALL
         SELECT links.media_id, links.channel_id, MAX(media.updated_at, links.created_at) AS activity_at
         FROM channel_media_links links
         JOIN media_assets media ON media.id = links.media_id AND media.workspace_id = links.workspace_id
         WHERE links.workspace_id = ? AND media.status != 'archived'
       )
       SELECT channel_id, COUNT(DISTINCT media_id) AS total, MAX(activity_at) AS last_activity_at
       FROM memberships
       WHERE channel_id IS NOT NULL
       GROUP BY channel_id`,
    ).bind(TAHA_WORKSPACE_ID, TAHA_WORKSPACE_ID).all<AggregateRow>(),
    db.prepare(
      `SELECT target_provider AS channel_id, COUNT(*) AS total, MAX(updated_at) AS last_activity_at
       FROM content_drafts
       WHERE workspace_id = ? AND status != 'archived'
       GROUP BY target_provider`,
    ).bind(TAHA_WORKSPACE_ID).all<AggregateRow>(),
    db.prepare(
      `SELECT COALESCE(d.target_provider, CASE WHEN c.provider = 'google' THEN NULL ELSE c.provider END) AS channel_id,
              SUM(CASE WHEN j.status IN ('queued', 'awaiting_confirmation', 'publishing', 'retry_wait') THEN 1 ELSE 0 END) AS queued_count,
              SUM(CASE WHEN j.status = 'published' THEN 1 ELSE 0 END) AS published_count,
              MAX(j.updated_at) AS last_activity_at
       FROM publish_jobs j
       JOIN channel_connections c ON c.id = j.connection_id AND c.workspace_id = j.workspace_id
       LEFT JOIN content_drafts d ON d.id = j.draft_id AND d.workspace_id = j.workspace_id
       WHERE j.workspace_id = ?
       GROUP BY 1`,
    ).bind(TAHA_WORKSPACE_ID).all<AggregateRow>(),
    db.prepare(
      `WITH memberships AS (
         SELECT 'google_sheets' AS channel_id, id AS product_id, updated_at AS activity_at
         FROM products
         WHERE workspace_id = ? AND deleted_at IS NULL AND status != 'archived'
         UNION ALL
         SELECT 'google_drive' AS channel_id, products.id AS product_id, products.updated_at AS activity_at
         FROM products
         JOIN product_media ON product_media.product_id = products.id AND product_media.workspace_id = products.workspace_id
         JOIN media_assets ON media_assets.id = product_media.media_id AND media_assets.workspace_id = products.workspace_id
         WHERE products.workspace_id = ? AND products.deleted_at IS NULL AND products.status != 'archived'
           AND (media_assets.channel_id = 'google_drive'
             OR (media_assets.channel_id IS NULL AND media_assets.storage_provider IN ('google_drive', 'r2')))
         UNION ALL
         SELECT drafts.target_provider AS channel_id, products.id AS product_id, products.updated_at AS activity_at
         FROM products
         JOIN content_drafts drafts ON drafts.product_id = products.id AND drafts.workspace_id = products.workspace_id
         WHERE products.workspace_id = ? AND products.deleted_at IS NULL AND products.status != 'archived'
           AND drafts.status != 'archived'
       )
       SELECT channel_id, COUNT(DISTINCT product_id) AS total, MAX(activity_at) AS last_activity_at
       FROM memberships
       GROUP BY channel_id`,
    ).bind(TAHA_WORKSPACE_ID, TAHA_WORKSPACE_ID, TAHA_WORKSPACE_ID).all<AggregateRow>(),
  ]);

  const connections = rows(connectionsResult);
  const media = aggregateMap(mediaResult);
  const drafts = aggregateMap(draftsResult);
  const jobs = aggregateMap(jobsResult);
  const products = aggregateMap(productsResult);

  return channelIds.map((channelId) => {
    const definition = channelDefinitions[channelId];
    const matchingConnections = connections.filter((connection) => connection.provider === definition.connectionProvider);
    const connected = matchingConnections.find((connection) => connection.status === "connected");
    const primary = connected ?? matchingConnections[0] ?? null;
    const mediaAggregate = media.get(channelId);
    const draftAggregate = drafts.get(channelId);
    const jobAggregate = jobs.get(channelId);
    const productAggregate = products.get(channelId);
    const connectionActivity = matchingConnections.reduce<number | null>(
      (latest, connection) => maxTimestamp(latest, connection.updated_at, connection.last_synced_at),
      null,
    );
    const status = primary?.status ?? "not_connected";

    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      connectionProvider: definition.connectionProvider,
      status,
      connectionId: primary?.id ?? null,
      connections: matchingConnections.map((connection) => ({
        id: connection.id,
        displayName: connection.display_name,
        externalAccountId: connection.external_account_id,
        status: connection.status,
        publishMode: connection.publish_mode,
        lastSyncedAt: asIso(connection.last_synced_at),
        lastError: connection.last_error,
      })),
      counts: {
        media: asNumber(mediaAggregate?.total),
        products: asNumber(productAggregate?.total),
        drafts: asNumber(draftAggregate?.total),
        queued: asNumber(jobAggregate?.queued_count),
        published: asNumber(jobAggregate?.published_count),
      },
      lastActivityAt: asIso(maxTimestamp(
        mediaAggregate?.last_activity_at,
        draftAggregate?.last_activity_at,
        jobAggregate?.last_activity_at,
        productAggregate?.last_activity_at,
        connectionActivity,
      )),
      actions: [...definition.actions],
      connectHref: definition.connectHref,
      allowedContentTypes: [...definition.contentTypes],
      defaultContentType: definition.defaultContentType,
    };
  });
}

export function sanitizeJobPayload(value: unknown) {
  const payload = safeJson<Record<string, unknown>>(value, {});
  const message = typeof payload.message === "string" ? payload.message.slice(0, 20_000) : "";
  const mediaIds = Array.isArray(payload.mediaIds)
    ? [...new Set(payload.mediaIds
        .filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 128)
        .slice(0, 20))]
    : [];
  return message || mediaIds.length ? { message, mediaIds } : null;
}

export async function getChannelLibrary(channelId: ChannelId, limit = 50) {
  const db = database();
  const summariesPromise = listChannelSummaries();
  const definition = channelDefinitions[channelId];
  const legacyDrive = channelId === "google_drive" ? 1 : 0;
  const [mediaResult, draftsResult, jobsResult, productsResult, summaries] = await Promise.all([
    db.prepare(
      `SELECT id, media_type, origin, mime_type, byte_size, alt_text, status, metadata_json, created_at, updated_at
       FROM media_assets
       WHERE workspace_id = ?
         AND (channel_id = ?
           OR (? = 1 AND channel_id IS NULL AND storage_provider IN ('google_drive', 'r2'))
           OR EXISTS (
             SELECT 1 FROM channel_media_links links
             WHERE links.workspace_id = media_assets.workspace_id
               AND links.media_id = media_assets.id
               AND links.channel_id = ?
           ))
         AND status != 'archived'
       ORDER BY created_at DESC
       LIMIT ?`,
    ).bind(TAHA_WORKSPACE_ID, channelId, legacyDrive, channelId, limit).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT d.id, d.product_id, p.name AS product_name, d.content_type, d.title, d.body,
              d.hashtags_json, d.status, d.created_at, d.updated_at
       FROM content_drafts d
       LEFT JOIN products p ON p.id = d.product_id AND p.workspace_id = d.workspace_id
       WHERE d.workspace_id = ? AND d.target_provider = ? AND d.status != 'archived'
       ORDER BY d.updated_at DESC
       LIMIT ?`,
    ).bind(TAHA_WORKSPACE_ID, channelId, limit).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT j.id, j.draft_id, j.status, j.job_kind, j.scheduled_for, j.external_url,
              j.error_message, j.payload_snapshot_json, j.created_at, j.updated_at
       FROM publish_jobs j
       JOIN channel_connections c ON c.id = j.connection_id AND c.workspace_id = j.workspace_id
       LEFT JOIN content_drafts d ON d.id = j.draft_id AND d.workspace_id = j.workspace_id
       WHERE j.workspace_id = ?
         AND (d.target_provider = ? OR (d.id IS NULL AND c.provider = ?))
       ORDER BY j.updated_at DESC
       LIMIT ?`,
    ).bind(TAHA_WORKSPACE_ID, channelId, definition.connectionProvider, limit).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT id, name, base_sku, status, updated_at
       FROM products
       WHERE workspace_id = ? AND deleted_at IS NULL AND status != 'archived'
       ORDER BY updated_at DESC
       LIMIT ?`,
    ).bind(TAHA_WORKSPACE_ID, limit).all<Record<string, unknown>>(),
    summariesPromise,
  ]);

  const channel = summaries.find((item) => item.id === channelId);
  if (!channel) throw new ChannelLibraryError("CHANNEL_NOT_FOUND", "Không tìm thấy kênh lưu trữ.", 404);

  const media = rows(mediaResult).map((row) => {
    const metadata = safeJson<Record<string, unknown>>(row.metadata_json, {});
    return {
      id: String(row.id),
      channelId,
      mediaType: String(row.media_type),
      origin: String(row.origin),
      mimeType: row.mime_type ? String(row.mime_type) : null,
      byteSize: asNullableNumber(row.byte_size),
      filename: typeof metadata.name === "string" ? metadata.name : "Tệp không tên",
      altText: row.alt_text ? String(row.alt_text) : null,
      status: String(row.status),
      createdAt: asIso(row.created_at),
      updatedAt: asIso(row.updated_at),
      downloadUrl: `/api/media/${encodeURIComponent(String(row.id))}/download`,
    };
  });

  const drafts = rows(draftsResult).map((row) => ({
    id: String(row.id),
    productId: row.product_id ? String(row.product_id) : null,
    productName: row.product_name ? String(row.product_name) : null,
    contentType: String(row.content_type),
    title: row.title ? String(row.title) : null,
    body: String(row.body ?? ""),
    hashtags: safeJson<string[]>(row.hashtags_json, []),
    status: String(row.status),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  }));

  const jobs = rows(jobsResult).map((row) => ({
    id: String(row.id),
    draftId: row.draft_id ? String(row.draft_id) : null,
    status: String(row.status),
    jobKind: String(row.job_kind),
    scheduledFor: asIso(row.scheduled_for),
    externalUrl: row.external_url ? String(row.external_url) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    payload: sanitizeJobPayload(row.payload_snapshot_json),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  }));

  const products = rows(productsResult).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    baseSku: String(row.base_sku),
    status: String(row.status),
    updatedAt: asIso(row.updated_at),
  }));

  return { channel, stats: channel.counts, media, drafts, jobs, products };
}

export type CreateDraftInput = {
  productId?: unknown;
  title?: unknown;
  body?: unknown;
  contentType?: unknown;
  hashtags?: unknown;
};

function optionalText(value: unknown, field: string, maxLength: number) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new ChannelLibraryError("INVALID_DRAFT", `${field} phải là văn bản.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new ChannelLibraryError("INVALID_DRAFT", `${field} vượt quá ${maxLength} ký tự.`);
  return normalized;
}

function validateHashtags(value: unknown) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30) {
    throw new ChannelLibraryError("INVALID_DRAFT", "Danh sách hashtag không hợp lệ.");
  }
  return value.map((item) => {
    if (typeof item !== "string") throw new ChannelLibraryError("INVALID_DRAFT", "Hashtag phải là văn bản.");
    const normalized = item.trim().replace(/^#+/, "");
    if (!normalized || normalized.length > 60) throw new ChannelLibraryError("INVALID_DRAFT", "Mỗi hashtag phải có từ 1 đến 60 ký tự.");
    return normalized;
  });
}

export function validateDraftInput(channelId: ChannelId, input: CreateDraftInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ChannelLibraryError("INVALID_DRAFT", "Dữ liệu bài viết không hợp lệ.");
  }
  const productId = optionalText(input.productId, "Sản phẩm", 128);
  if (!productId) throw new ChannelLibraryError("PRODUCT_REQUIRED", "Hãy chọn sản phẩm cho bài viết.");
  const title = optionalText(input.title, "Tiêu đề", 240);
  const body = optionalText(input.body, "Nội dung", 20_000);
  if (!title && !body) throw new ChannelLibraryError("CONTENT_REQUIRED", "Hãy nhập tiêu đề hoặc nội dung bài viết.");
  const definition = channelDefinitions[channelId];
  const contentType = input.contentType === undefined ? definition.defaultContentType : optionalText(input.contentType, "Loại nội dung", 80);
  if (!definition.contentTypes.includes(contentType as DraftContentType)) {
    throw new ChannelLibraryError("CONTENT_TYPE_NOT_ALLOWED", "Loại nội dung không phù hợp với kênh đã chọn.");
  }
  return { productId, title: title || null, body, contentType: contentType as DraftContentType, hashtags: validateHashtags(input.hashtags) };
}

export async function createChannelDraft(channelId: ChannelId, input: CreateDraftInput, actorId: string | null) {
  const values = validateDraftInput(channelId, input);
  await ensureWorkspace();
  const db = database();
  const product = await db.prepare(
    `SELECT id, name FROM products
     WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND status != 'archived'
     LIMIT 1`,
  ).bind(values.productId, TAHA_WORKSPACE_ID).first<{ id: string; name: string }>();
  if (!product) throw new ChannelLibraryError("PRODUCT_NOT_FOUND", "Không tìm thấy sản phẩm trong kho làm việc.", 404);

  const id = crypto.randomUUID();
  const now = Date.now();
  const auditId = crypto.randomUUID();
  await db.batch([
    db.prepare(
      `INSERT INTO content_drafts
       (id, workspace_id, product_id, target_provider, content_type, language, title, body,
        hashtags_json, platform_data_json, status, version, generation_meta_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'vi', ?, ?, ?, '{}', 'draft', 1, '{}', ?, ?)`,
    ).bind(id, TAHA_WORKSPACE_ID, product.id, channelId, values.contentType, values.title, values.body, JSON.stringify(values.hashtags), now, now),
    db.prepare(
      `INSERT INTO audit_logs
       (id, workspace_id, actor_type, actor_id, action, entity_type, entity_id, after_json, metadata_json, created_at)
       VALUES (?, ?, 'user', ?, 'channel.draft.created', 'content_draft', ?, ?, ?, ?)`,
    ).bind(auditId, TAHA_WORKSPACE_ID, actorId, id, JSON.stringify({ title: values.title, contentType: values.contentType }), JSON.stringify({ channelId }), now),
  ]);

  return {
    id,
    productId: product.id,
    productName: product.name,
    channelId,
    contentType: values.contentType,
    title: values.title,
    body: values.body,
    hashtags: values.hashtags,
    status: "draft",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

export type MediaImportInput = { mediaIds?: unknown };

export function validateMediaImportInput(channelId: ChannelId, input: MediaImportInput) {
  if (!mediaImportTargetIds.includes(channelId as MediaImportTargetId)) {
    throw new ChannelLibraryError(
      "CHANNEL_IMPORT_NOT_ALLOWED",
      "Chỉ có thể dùng lại ảnh nguồn cho Facebook, Zalo, TikTok Shop, Shopee hoặc Website.",
      409,
    );
  }
  if (!input || typeof input !== "object" || !Array.isArray(input.mediaIds)) {
    throw new ChannelLibraryError("INVALID_MEDIA_IDS", "Danh sách media không hợp lệ.", 422);
  }
  const mediaIds = [...new Set(input.mediaIds.map((value) => {
    if (typeof value !== "string") throw new ChannelLibraryError("INVALID_MEDIA_IDS", "Mỗi media ID phải là văn bản.", 422);
    const normalized = value.trim();
    if (!normalized || normalized.length > 128) throw new ChannelLibraryError("INVALID_MEDIA_IDS", "Media ID không hợp lệ.", 422);
    return normalized;
  }))];
  if (mediaIds.length < 1 || mediaIds.length > 20) {
    throw new ChannelLibraryError("INVALID_MEDIA_IDS", "Mỗi lần chỉ được chọn từ 1 đến 20 tệp nguồn.", 422);
  }
  return { channelId: channelId as MediaImportTargetId, mediaIds };
}

export async function importChannelMedia(channelId: ChannelId, input: MediaImportInput, actorId: string | null) {
  const values = validateMediaImportInput(channelId, input);
  await ensureWorkspace();
  const db = database();
  const placeholders = values.mediaIds.map(() => "?").join(", ");
  const sourceAssets = await db.prepare(
    `SELECT id
     FROM media_assets
     WHERE workspace_id = ? AND id IN (${placeholders}) AND status = 'ready'
       AND (channel_id = 'google_drive'
         OR (channel_id IS NULL AND storage_provider IN ('google_drive', 'r2')))` ,
  ).bind(TAHA_WORKSPACE_ID, ...values.mediaIds).all<{ id: string }>();
  const sourceIds = new Set(rows(sourceAssets).map((row) => row.id));
  if (sourceIds.size !== values.mediaIds.length) {
    throw new ChannelLibraryError("SOURCE_MEDIA_NOT_FOUND", "Một hoặc nhiều tệp nguồn không tồn tại hoặc chưa sẵn sàng.", 404);
  }

  const now = Date.now();
  const insertStatements = values.mediaIds.map((mediaId) => db.prepare(
    `INSERT INTO channel_media_links (id, workspace_id, channel_id, media_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, channel_id, media_id) DO NOTHING`,
  ).bind(crypto.randomUUID(), TAHA_WORKSPACE_ID, values.channelId, mediaId, actorId, now));
  const results = await db.batch(insertStatements);
  const imported = results.reduce((total, result) => total + asNumber(result.meta?.changes), 0);
  const alreadyLinked = values.mediaIds.length - imported;

  if (imported > 0) {
    await db.prepare(
      `INSERT INTO audit_logs
       (id, workspace_id, actor_type, actor_id, action, entity_type, metadata_json, created_at)
       VALUES (?, ?, 'user', ?, 'channel.media.imported', 'channel_media_link', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      TAHA_WORKSPACE_ID,
      actorId,
      JSON.stringify({ channelId: values.channelId, mediaIds: values.mediaIds, imported }),
      now,
    ).run();
  }

  return { imported, alreadyLinked };
}

export type UploadInput = {
  file: File;
  altText?: string | null;
  productId?: string | null;
  draftId?: string | null;
};

function sanitizeFilename(value: string) {
  const normalized = Array.from(value.normalize("NFKC"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 || character === "/" || character === "\\" ? "-" : character;
  }).join("").trim();
  return (normalized || "upload").slice(0, 180);
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

export function matchesFileSignature(mimeType: AllowedMimeType, bytes: Uint8Array) {
  if (mimeType === "image/jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (mimeType === "image/png") return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mimeType === "image/gif") return ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a";
  if (mimeType === "image/webp") return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
  if (mimeType === "video/webm") return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
  if (mimeType === "video/mp4" || mimeType === "video/quicktime") return ascii(bytes, 4, 4) === "ftyp";
  return false;
}

function validateOptionalId(value: string | null | undefined, label: string) {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) throw new ChannelLibraryError("INVALID_UPLOAD", `${label} không hợp lệ.`);
  return normalized;
}

export async function uploadChannelMedia(channelId: ChannelId, input: UploadInput, actorId: string | null) {
  if (!(input.file instanceof File)) throw new ChannelLibraryError("FILE_REQUIRED", "Hãy chọn ảnh hoặc video để tải lên.");
  const mimeType = input.file.type.toLowerCase() as AllowedMimeType;
  const definition = mimeDefinitions[mimeType];
  if (!definition) throw new ChannelLibraryError("FILE_TYPE_NOT_ALLOWED", "Chỉ hỗ trợ JPG, PNG, WEBP, GIF, MP4, WEBM hoặc MOV.", 415);
  if (input.file.size < 1) throw new ChannelLibraryError("EMPTY_FILE", "Tệp tải lên đang trống.");
  if (input.file.size > definition.maxBytes) {
    const maxMb = Math.floor(definition.maxBytes / 1024 / 1024);
    throw new ChannelLibraryError("FILE_TOO_LARGE", `Tệp vượt quá giới hạn ${maxMb} MB.`, 413);
  }
  const altText = optionalText(input.altText, "Mô tả ảnh", 500) || null;
  const productId = validateOptionalId(input.productId, "Sản phẩm");
  const draftId = validateOptionalId(input.draftId, "Bài viết");
  const buffer = await input.file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (!matchesFileSignature(mimeType, bytes)) {
    throw new ChannelLibraryError("FILE_SIGNATURE_MISMATCH", "Nội dung tệp không khớp với định dạng đã khai báo.", 415);
  }

  await ensureWorkspace();
  const db = database();
  if (productId) {
    const product = await db.prepare(
      `SELECT id FROM products WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL LIMIT 1`,
    ).bind(productId, TAHA_WORKSPACE_ID).first<{ id: string }>();
    if (!product) throw new ChannelLibraryError("PRODUCT_NOT_FOUND", "Không tìm thấy sản phẩm trong kho làm việc.", 404);
  }
  if (draftId) {
    const draft = await db.prepare(
      `SELECT id, target_provider FROM content_drafts
       WHERE id = ? AND workspace_id = ? AND status != 'archived' LIMIT 1`,
    ).bind(draftId, TAHA_WORKSPACE_ID).first<{ id: string; target_provider: string }>();
    if (!draft) throw new ChannelLibraryError("DRAFT_NOT_FOUND", "Không tìm thấy bài viết trong kho làm việc.", 404);
    if (draft.target_provider !== channelId) {
      throw new ChannelLibraryError("DRAFT_CHANNEL_MISMATCH", "Bài viết thuộc một kênh khác.", 409);
    }
  }

  const bucket = getRuntimeEnv().MEDIA;
  if (!bucket) throw new ChannelLibraryError("MEDIA_STORAGE_UNAVAILABLE", "Kho tệp chưa sẵn sàng.", 503);
  const id = crypto.randomUUID();
  const now = Date.now();
  const date = new Date(now);
  const storageKey = `channels/${TAHA_WORKSPACE_ID}/${channelId}/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${id}.${definition.extension}`;
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const filename = sanitizeFilename(input.file.name);

  await bucket.put(storageKey, buffer, {
    httpMetadata: { contentType: mimeType, contentDisposition: "attachment" },
    customMetadata: { channelId, workspaceId: TAHA_WORKSPACE_ID },
    sha256,
  });

  const statements = [
    db.prepare(
      `INSERT INTO media_assets
       (id, workspace_id, channel_id, media_type, origin, storage_provider, storage_key,
        mime_type, byte_size, sha256, alt_text, status, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'uploaded', 'r2', ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
    ).bind(id, TAHA_WORKSPACE_ID, channelId, definition.mediaType, storageKey, mimeType, input.file.size, sha256, altText, JSON.stringify({ name: filename }), now, now),
    db.prepare(
      `INSERT INTO audit_logs
       (id, workspace_id, actor_type, actor_id, action, entity_type, entity_id, after_json, metadata_json, created_at)
       VALUES (?, ?, 'user', ?, 'channel.media.uploaded', 'media_asset', ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), TAHA_WORKSPACE_ID, actorId, id, JSON.stringify({ filename, mimeType, byteSize: input.file.size }), JSON.stringify({ channelId }), now),
  ];
  if (productId) {
    statements.push(db.prepare(
      `INSERT INTO product_media (id, workspace_id, product_id, media_id, role, sort_order, created_at)
       VALUES (?, ?, ?, ?, 'gallery', 0, ?)`,
    ).bind(crypto.randomUUID(), TAHA_WORKSPACE_ID, productId, id, now));
  }
  if (draftId) {
    statements.push(db.prepare(
      `INSERT INTO content_draft_media (id, workspace_id, draft_id, media_id, role, sort_order, created_at)
       VALUES (?, ?, ?, ?, 'attachment', 0, ?)`,
    ).bind(crypto.randomUUID(), TAHA_WORKSPACE_ID, draftId, id, now));
  }

  try {
    await db.batch(statements);
  } catch (error) {
    await bucket.delete(storageKey).catch(() => undefined);
    throw error;
  }

  return {
    id,
    channelId,
    mediaType: definition.mediaType,
    origin: "uploaded",
    mimeType,
    byteSize: input.file.size,
    filename,
    altText,
    status: "ready",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    downloadUrl: `/api/media/${encodeURIComponent(id)}/download`,
  };
}
