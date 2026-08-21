import { getRuntimeEnv } from "./integrations/env";
import { TAHA_WORKSPACE_ID } from "./integrations/store";
import { parseTikTokListingConfig, preflightTikTokListing, type TikTokProductSnapshot } from "./tiktok-shop-listing";

export const COMMERCE_PUBLISH_PROVIDERS = ["tiktok_shop", "shopee"] as const;
type CommerceProvider = (typeof COMMERCE_PUBLISH_PROVIDERS)[number];

type CommerceStatement = {
  bind(...values: unknown[]): CommerceStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
};

type CommerceDatabase = { prepare(query: string): CommerceStatement };

export type TikTokListingConfigurationInput = {
  categoryId?: unknown;
  warehouseId?: unknown;
  weightValue?: unknown;
  weightUnit?: unknown;
  brandId?: unknown;
  salesAttributesBySku?: unknown;
  productAttributes?: unknown;
  saveMode?: unknown;
};

export class CommercePublishError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(code);
    this.name = "CommercePublishError";
  }
}

function database() {
  const value = getRuntimeEnv().DB as unknown as CommerceDatabase | undefined;
  if (!value) throw new CommercePublishError("DATABASE_UNAVAILABLE", "Cơ sở dữ liệu chưa sẵn sàng.", 503);
  return value;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function requiredProvider(value: string): CommerceProvider {
  if (!COMMERCE_PUBLISH_PROVIDERS.includes(value as CommerceProvider)) {
    throw new CommercePublishError("COMMERCE_PROVIDER_INVALID", "Kênh thương mại không hợp lệ.", 404);
  }
  return value as CommerceProvider;
}

function cleanText(value: unknown, field: string, maxLength = 120, required = true) {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return "";
    throw new CommercePublishError("TIKTOK_CONFIG_INVALID", `${field} không hợp lệ.`, 422);
  }
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maxLength) {
    throw new CommercePublishError("TIKTOK_CONFIG_INVALID", `${field} không hợp lệ.`, 422);
  }
  return normalized;
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function saveTikTokListingConfiguration(
  productId: string,
  input: TikTokListingConfigurationInput,
) {
  const categoryId = cleanText(input.categoryId, "Category ID");
  const warehouseId = cleanText(input.warehouseId, "Warehouse ID");
  const weightValue = Number(input.weightValue);
  if (!Number.isFinite(weightValue) || weightValue <= 0 || weightValue > 1_000_000) {
    throw new CommercePublishError("TIKTOK_CONFIG_INVALID", "Khối lượng sản phẩm phải lớn hơn 0.", 422);
  }
  const weightUnit = cleanText(input.weightUnit ?? "GRAM", "Đơn vị khối lượng", 20).toUpperCase();
  if (!new Set(["GRAM", "KILOGRAM", "POUND", "OUNCE"]).has(weightUnit)) {
    throw new CommercePublishError("TIKTOK_CONFIG_INVALID", "Đơn vị khối lượng TikTok không hợp lệ.", 422);
  }
  const draft = await database().prepare(
    `SELECT id, title, body, platform_data_json, version FROM content_drafts
     WHERE workspace_id = ? AND product_id = ? AND target_provider = 'tiktok_shop'
       AND content_type = 'product_listing' AND status = 'approved'
     ORDER BY updated_at DESC LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID, productId).first<{
    id: string;
    title: string | null;
    body: string;
    platform_data_json: string;
    version: number;
  }>();
  if (!draft) {
    throw new CommercePublishError("COMMERCE_LISTING_DRAFT_REQUIRED", "Hãy chạy AI để tạo listing TikTok trước.", 409);
  }
  const salesAttributesBySku = object(input.salesAttributesBySku);
  const productAttributes = Array.isArray(input.productAttributes)
    ? input.productAttributes.filter((item) => item && typeof item === "object" && !Array.isArray(item))
    : [];
  const platformData = parseJson<Record<string, unknown>>(draft.platform_data_json, {});
  const nextPlatformData = {
    ...platformData,
    tiktokShop: {
      categoryId,
      categoryVersion: "v2",
      warehouseId,
      packageWeight: { value: weightValue, unit: weightUnit },
      ...(cleanText(input.brandId, "Brand ID", 120, false) ? { brandId: cleanText(input.brandId, "Brand ID", 120, false) } : {}),
      ...(Object.keys(salesAttributesBySku).length ? { salesAttributesBySku } : {}),
      ...(productAttributes.length ? { productAttributes } : {}),
      saveMode: input.saveMode === "LISTING" ? "LISTING" : "AS_DRAFT",
    },
  };
  const now = Date.now();
  await database().prepare(
    `UPDATE content_drafts SET platform_data_json = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
  ).bind(JSON.stringify(nextPlatformData), now, draft.id, TAHA_WORKSPACE_ID).run();

  const media = await database().prepare(
    `SELECT dm.media_id FROM content_draft_media dm JOIN media_assets m ON m.id = dm.media_id
     WHERE dm.workspace_id = ? AND dm.draft_id = ? AND m.status = 'ready' AND m.media_type = 'image'
     ORDER BY dm.sort_order, dm.created_at LIMIT 9`,
  ).bind(TAHA_WORKSPACE_ID, draft.id).all<{ media_id: string }>();
  const product = await snapshot(productId, draft.title?.trim() ?? "", draft.body.trim());
  const issues = preflightTikTokListing({
    product,
    config: parseTikTokListingConfig(nextPlatformData),
    imageUris: (media.results ?? []).map((item) => `pending:${item.media_id}`),
  });
  return { draftId: draft.id, version: draft.version + 1, ready: issues.length === 0, issues };
}

async function snapshot(productId: string, title: string, description: string): Promise<TikTokProductSnapshot & { version: number }> {
  const product = await database().prepare(
    `SELECT id, name, description, currency, version FROM products
     WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND status != 'archived' LIMIT 1`,
  ).bind(productId, TAHA_WORKSPACE_ID).first<{ id: string; name: string; description: string; currency: string; version: number }>();
  if (!product) throw new CommercePublishError("PRODUCT_NOT_FOUND", "Không tìm thấy sản phẩm.", 404);
  const variants = await database().prepare(
    `SELECT id, sku, price_minor, inventory_quantity FROM product_variants
     WHERE product_id = ? AND workspace_id = ? AND status = 'active' ORDER BY sort_order, created_at`,
  ).bind(productId, TAHA_WORKSPACE_ID).all<{ id: string; sku: string; price_minor: number; inventory_quantity: number }>();
  return {
    id: product.id,
    name: title || product.name,
    description: description || product.description,
    currency: product.currency,
    version: product.version,
    variants: (variants.results ?? []).map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      priceMinor: Number(variant.price_minor),
      inventoryQuantity: Number(variant.inventory_quantity),
    })),
  };
}

export async function queueCommerceProductPublish(providerValue: string, productId: string, connectionId?: string | null) {
  const provider = requiredProvider(providerValue);
  if (provider === "shopee") {
    throw new CommercePublishError(
      "SHOPEE_APPROVAL_PENDING",
      "Shopee đang xét duyệt hồ sơ Open Platform. Hệ thống sẽ mở nút đăng ngay khi ứng dụng được cấp quyền Product và Media Space.",
      409,
    );
  }
  const connection = connectionId
    ? await database().prepare(
      `SELECT id, status FROM channel_connections WHERE id = ? AND workspace_id = ? AND provider = ? LIMIT 1`,
    ).bind(connectionId, TAHA_WORKSPACE_ID, provider).first<{ id: string; status: string }>()
    : await database().prepare(
      `SELECT id, status FROM channel_connections WHERE workspace_id = ? AND provider = ?
       ORDER BY updated_at DESC LIMIT 1`,
    ).bind(TAHA_WORKSPACE_ID, provider).first<{ id: string; status: string }>();
  if (!connection || connection.status !== "connected") {
    throw new CommercePublishError("COMMERCE_CONNECTION_REQUIRED", "Kênh chưa kết nối hoặc chưa được duyệt.", 409);
  }
  const draft = await database().prepare(
    `SELECT id, title, body, platform_data_json, version FROM content_drafts
     WHERE workspace_id = ? AND product_id = ? AND target_provider = ?
       AND content_type = 'product_listing' AND status = 'approved'
     ORDER BY updated_at DESC LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID, productId, provider).first<{
    id: string;
    title: string | null;
    body: string;
    platform_data_json: string;
    version: number;
  }>();
  if (!draft) {
    throw new CommercePublishError("COMMERCE_LISTING_DRAFT_REQUIRED", "Sản phẩm chưa có nội dung listing đã duyệt.", 409);
  }
  const media = await database().prepare(
    `SELECT dm.media_id FROM content_draft_media dm JOIN media_assets m ON m.id = dm.media_id
     WHERE dm.workspace_id = ? AND dm.draft_id = ? AND m.status = 'ready' AND m.media_type = 'image'
     ORDER BY dm.sort_order, dm.created_at LIMIT 9`,
  ).bind(TAHA_WORKSPACE_ID, draft.id).all<{ media_id: string }>();
  const mediaIds = (media.results ?? []).map((item) => item.media_id);
  const product = await snapshot(productId, draft.title?.trim() ?? "", draft.body.trim());
  const platformData = parseJson<Record<string, unknown>>(draft.platform_data_json, {});
  const config = parseTikTokListingConfig(platformData);
  const issues = preflightTikTokListing({
    product,
    config,
    imageUris: mediaIds.map((id) => `pending:${id}`),
  });
  if (issues.length) {
    throw new CommercePublishError(
      "TIKTOK_LISTING_NOT_READY",
      "Listing TikTok còn thiếu thông tin bắt buộc. Hãy bổ sung danh mục, kho, khối lượng hoặc thuộc tính biến thể.",
      409,
      { issues },
    );
  }
  const mapping = await database().prepare(
    `SELECT external_id FROM channel_mappings WHERE workspace_id = ? AND connection_id = ?
     AND entity_type = 'product' AND entity_id = ? LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID, connection.id, productId).first<{ external_id: string }>();
  if (mapping) {
    throw new CommercePublishError(
      "TIKTOK_PRODUCT_UPDATE_REQUIRES_REMOTE_SNAPSHOT",
      "Sản phẩm đã tồn tại trên TikTok Shop; cần đối chiếu bản từ xa trước khi cập nhật để không ghi đè dữ liệu Seller Center.",
      409,
    );
  }
  const now = Date.now();
  const dedupeKey = `commerce:${provider}:${connection.id}:${productId}:p${product.version}:d${draft.version}`;
  const payload = {
    provider,
    contentType: "product_listing",
    listingTitle: product.name,
    listingDescription: product.description,
    mediaIds,
    platformData,
    productSnapshot: product,
    productVersion: product.version,
    draftVersion: draft.version,
  };
  const inserted = await database().prepare(
    `INSERT INTO publish_jobs
     (id, workspace_id, connection_id, product_id, draft_id, job_kind, dedupe_key, status,
      scheduled_for, available_at, payload_snapshot_json, attempt_count, max_attempts,
      provider_response_json, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, 'listing_upsert', ?, 'queued', ?, ?, ?, 0, 5, '{}', ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM publish_jobs existing
       WHERE existing.workspace_id = ? AND existing.connection_id = ?
         AND existing.product_id = ? AND existing.job_kind = 'listing_upsert'
         AND existing.dedupe_key != ?
         AND (
           existing.status IN ('queued', 'retry_wait', 'publishing')
           OR existing.error_code = 'TIKTOK_MAPPING_PENDING'
           OR existing.error_code = 'DELIVERY_OUTCOME_UNKNOWN'
           OR (
             existing.external_post_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM channel_mappings mapped
               WHERE mapped.workspace_id = existing.workspace_id
                 AND mapped.connection_id = existing.connection_id
                 AND mapped.entity_type = 'product'
                 AND mapped.entity_id = existing.product_id
             )
           )
         )
     )
     AND NOT EXISTS (
       SELECT 1 FROM channel_mappings mapped
       WHERE mapped.workspace_id = ? AND mapped.connection_id = ?
         AND mapped.entity_type = 'product' AND mapped.entity_id = ?
     )
     ON CONFLICT(dedupe_key) DO NOTHING`,
  ).bind(
    crypto.randomUUID(), TAHA_WORKSPACE_ID, connection.id, productId, draft.id, dedupeKey,
    now, now, JSON.stringify(payload), now, now,
    TAHA_WORKSPACE_ID, connection.id, productId, dedupeKey,
    TAHA_WORKSPACE_ID, connection.id, productId,
  ).run();
  const job = await database().prepare(
    `SELECT id, status, dedupe_key, scheduled_for, external_post_id, error_code FROM publish_jobs
     WHERE workspace_id = ? AND dedupe_key = ? LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID, dedupeKey).first<Record<string, unknown>>();
  if (!job) {
    const mappedNow = await database().prepare(
      `SELECT external_id FROM channel_mappings WHERE workspace_id = ? AND connection_id = ?
       AND entity_type = 'product' AND entity_id = ? LIMIT 1`,
    ).bind(TAHA_WORKSPACE_ID, connection.id, productId).first<{ external_id: string }>();
    if (mappedNow) {
      throw new CommercePublishError(
        "TIKTOK_PRODUCT_UPDATE_REQUIRES_REMOTE_SNAPSHOT",
        "Sản phẩm đã tồn tại trên TikTok Shop; cần đối chiếu bản từ xa trước khi cập nhật để không ghi đè dữ liệu Seller Center.",
        409,
      );
    }
    const blocker = await database().prepare(
      `SELECT status, error_code, external_post_id FROM publish_jobs existing
       WHERE existing.workspace_id = ? AND existing.connection_id = ?
         AND existing.product_id = ? AND existing.job_kind = 'listing_upsert'
         AND existing.dedupe_key != ?
         AND (
           existing.status IN ('queued', 'retry_wait', 'publishing')
           OR existing.error_code = 'TIKTOK_MAPPING_PENDING'
           OR existing.error_code = 'DELIVERY_OUTCOME_UNKNOWN'
           OR (
             existing.external_post_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM channel_mappings mapped
               WHERE mapped.workspace_id = existing.workspace_id
                 AND mapped.connection_id = existing.connection_id
                 AND mapped.entity_type = 'product'
                 AND mapped.entity_id = existing.product_id
             )
           )
         )
       ORDER BY existing.created_at ASC LIMIT 1`,
    ).bind(TAHA_WORKSPACE_ID, connection.id, productId, dedupeKey).first<{
      status: string;
      error_code: string | null;
      external_post_id: string | null;
    }>();
    if (
      blocker?.external_post_id
      || blocker?.error_code === "TIKTOK_MAPPING_PENDING"
      || blocker?.error_code === "DELIVERY_OUTCOME_UNKNOWN"
    ) {
      throw new CommercePublishError(
        "TIKTOK_PRODUCT_RECONCILIATION_REQUIRED",
        "TikTok đã nhận sản phẩm nhưng liên kết nội bộ chưa hoàn tất. Hệ thống sẽ tự đối soát trước khi cho phép đăng lại.",
        409,
      );
    }
    if (blocker) {
      throw new CommercePublishError(
        "TIKTOK_PRODUCT_PUBLISH_IN_FLIGHT",
        "Sản phẩm này đang được gửi lên TikTok Shop. Hãy chờ công việc hiện tại hoàn tất.",
        409,
      );
    }
    throw new CommercePublishError("COMMERCE_QUEUE_FAILED", "Không thể tạo công việc đăng sản phẩm.", 500);
  }
  if (job.external_post_id || job.error_code === "TIKTOK_MAPPING_PENDING") {
    throw new CommercePublishError(
      "TIKTOK_PRODUCT_RECONCILIATION_REQUIRED",
      "TikTok đã nhận sản phẩm nhưng liên kết nội bộ chưa hoàn tất. Hệ thống sẽ tự đối soát trước khi cho phép đăng lại.",
      409,
    );
  }
  return { job, replayed: Number(inserted.meta?.changes ?? 0) === 0 };
}
