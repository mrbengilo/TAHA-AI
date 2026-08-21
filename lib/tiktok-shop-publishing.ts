import { getRuntimeEnv } from "./integrations/env";
import {
  getConnectedIntegration,
  getTikTokShopAccessToken,
  type RefreshableCredentials,
} from "./integrations/connection-secrets";
import {
  callTikTokShopJson,
  TikTokShopApiError,
  uploadTikTokShopProductImage,
} from "./integrations/tiktok-shop-api";
import { TAHA_WORKSPACE_ID } from "./integrations/store";
import { mediaBlob } from "./media";
import { PublishDeliveryError } from "./publishing";
import {
  buildTikTokCreateProductBody,
  parseTikTokListingConfig,
  preflightTikTokListing,
  type TikTokProductSnapshot,
} from "./tiktok-shop-listing";

type ProductMappingRow = { external_id: string };

type PublishConflictRow = {
  id: string;
  status: string;
  error_code: string | null;
  external_post_id: string | null;
};

type TikTokImageUploadState = {
  mediaId: string;
  uri: string;
};

type TikTokSkuResponse = {
  id: string;
  externalSkuId: string | null;
};

export type TikTokShopRemoteInput = {
  connectionId: string;
  jobId: string;
  workerId: string;
  productId: string;
  payload: Record<string, unknown>;
  progress: Record<string, unknown>;
  externalId?: string | null;
};

function database() {
  const value = getRuntimeEnv().DB;
  if (!value) throw new PublishDeliveryError("DATABASE_UNAVAILABLE", { retryable: true });
  return value;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function mediaIds(payload: Record<string, unknown>) {
  return Array.isArray(payload.mediaIds)
    ? [...new Set(payload.mediaIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0))].slice(0, 9)
    : [];
}

function productSnapshot(productId: string, payload: Record<string, unknown>): TikTokProductSnapshot {
  const product = object(payload.productSnapshot);
  const id = text(product.id);
  if (!id || id !== productId || !Array.isArray(product.variants)) {
    throw new PublishDeliveryError("TIKTOK_PRODUCT_SNAPSHOT_INVALID");
  }
  return {
    id,
    name: text(product.name),
    description: text(product.description),
    currency: text(product.currency).toUpperCase(),
    variants: product.variants.map((value) => {
      const variant = object(value);
      return {
        id: text(variant.id),
        sku: text(variant.sku),
        priceMinor: Number(variant.priceMinor),
        inventoryQuantity: Number(variant.inventoryQuantity),
      };
    }),
  };
}

function imageUploadState(value: Record<string, unknown>) {
  if (!Array.isArray(value.tiktokImageUploads)) return [];
  const seen = new Set<string>();
  return value.tiktokImageUploads.flatMap((entry): TikTokImageUploadState[] => {
    const item = object(entry);
    const mediaId = text(item.mediaId);
    const uri = text(item.uri);
    if (!mediaId || !uri || seen.has(mediaId)) return [];
    seen.add(mediaId);
    return [{ mediaId, uri }];
  });
}

async function persistImageUploadState(input: TikTokShopRemoteInput, uploads: TikTokImageUploadState[]) {
  const nextProgress = {
    ...input.progress,
    tiktokImageUploads: uploads,
  };
  const result = await database().prepare(
    `UPDATE publish_jobs SET provider_response_json = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status = 'publishing' AND lease_owner = ?`,
  ).bind(
    JSON.stringify(nextProgress),
    Date.now(),
    input.jobId,
    TAHA_WORKSPACE_ID,
    input.workerId,
  ).run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new PublishDeliveryError("TIKTOK_IMAGE_STATE_PERSIST_FAILED", { outcomeUnknown: true });
  }
  input.progress = nextProgress;
}

function mapApiError(error: unknown): never {
  if (error instanceof TikTokShopApiError) {
    throw new PublishDeliveryError(error.code, {
      retryable: error.retryable,
      outcomeUnknown: error.outcomeUnknown,
    });
  }
  if (error instanceof PublishDeliveryError) throw error;
  const code = error instanceof Error ? error.message : "TIKTOK_SHOP_PUBLISH_FAILED";
  throw new PublishDeliveryError(code);
}

async function existingProductMapping(connectionId: string, productId: string) {
  return database().prepare(
    `SELECT external_id FROM channel_mappings
     WHERE workspace_id = ? AND connection_id = ? AND entity_type = 'product' AND entity_id = ? LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID, connectionId, productId).first<ProductMappingRow>();
}

async function existingPublishConflict(input: TikTokShopRemoteInput) {
  return database().prepare(
    `SELECT existing.id, existing.status, existing.error_code, existing.external_post_id
     FROM publish_jobs existing
     WHERE existing.workspace_id = ? AND existing.connection_id = ?
       AND existing.product_id = ? AND existing.job_kind = 'listing_upsert'
       AND existing.id != ?
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
  ).bind(TAHA_WORKSPACE_ID, input.connectionId, input.productId, input.jobId).first<PublishConflictRow>();
}

function responseSkus(value: unknown): TikTokSkuResponse[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = object(entry);
    const id = text(item.id);
    if (!id) return [];
    return [{
      id,
      externalSkuId: text(item.external_sku_id) || text(item.externalSkuId) || null,
    }];
  });
}

export async function sendTikTokShopListing(input: TikTokShopRemoteInput) {
  try {
    const connection = await getConnectedIntegration<RefreshableCredentials>("tiktok_shop", input.connectionId);
    const shopCipher = text(connection.config.shopCipher);
    if (!shopCipher) throw new PublishDeliveryError("TIKTOK_SHOP_CIPHER_MISSING");
    const product = productSnapshot(input.productId, input.payload);
    const config = parseTikTokListingConfig(object(input.payload.platformData));
    const selectedMediaIds = mediaIds(input.payload);
    const localIssues = preflightTikTokListing({
      product,
      config,
      imageUris: selectedMediaIds.map((id) => `pending:${id}`),
    });
    if (localIssues.length > 0) throw new PublishDeliveryError(localIssues[0].code);
    if (!config) throw new PublishDeliveryError("TIKTOK_LISTING_CONFIG_REQUIRED");

    // Editing a TikTok product safely requires fetching the current remote
    // snapshot and merging fields managed outside TAHA. Until that read/merge
    // flow is implemented, stop before uploading media or mutating TikTok.
    const existing = await existingProductMapping(input.connectionId, input.productId);
    if (existing) throw new PublishDeliveryError("TIKTOK_PRODUCT_UPDATE_REQUIRES_REMOTE_SNAPSHOT");
    if (input.externalId) throw new PublishDeliveryError("TIKTOK_PRODUCT_RECONCILIATION_REQUIRED");
    const conflict = await existingPublishConflict(input);
    if (
      conflict?.external_post_id
      || conflict?.error_code === "TIKTOK_MAPPING_PENDING"
      || conflict?.error_code === "DELIVERY_OUTCOME_UNKNOWN"
    ) {
      throw new PublishDeliveryError("TIKTOK_PRODUCT_RECONCILIATION_REQUIRED");
    }
    if (conflict) throw new PublishDeliveryError("TIKTOK_PRODUCT_PUBLISH_IN_FLIGHT");

    const accessToken = await getTikTokShopAccessToken(connection);
    const uploadedImages = imageUploadState(input.progress)
      .filter((image) => selectedMediaIds.includes(image.mediaId));
    for (const mediaId of selectedMediaIds) {
      if (uploadedImages.some((image) => image.mediaId === mediaId)) continue;
      const media = await mediaBlob(mediaId, 10 * 1024 * 1024);
      if (!["image/jpeg", "image/png", "image/webp"].includes(media.mimeType.toLowerCase())) {
        throw new PublishDeliveryError("TIKTOK_IMAGE_TYPE_UNSUPPORTED");
      }
      const uploaded = await uploadTikTokShopProductImage({
        accessToken,
        blob: media.blob,
        filename: media.filename,
      });
      uploadedImages.push({ mediaId, uri: uploaded.uri });
      await persistImageUploadState(input, uploadedImages);
    }

    const orderedImageUris = selectedMediaIds.map((mediaId) => (
      uploadedImages.find((image) => image.mediaId === mediaId)?.uri ?? ""
    ));
    if (orderedImageUris.some((uri) => !uri)) {
      throw new PublishDeliveryError("TIKTOK_IMAGE_STATE_INCOMPLETE", { outcomeUnknown: true });
    }

    const body = buildTikTokCreateProductBody({
      product,
      config,
      imageUris: orderedImageUris,
    });
    const response = await callTikTokShopJson({
      path: "/product/202309/products",
      method: "POST",
      accessToken,
      query: { shop_cipher: shopCipher },
      body,
      idempotencyKey: input.jobId,
    });
    const externalId = text(response.data.product_id) || text(response.data.id);
    if (!externalId) throw new PublishDeliveryError("TIKTOK_PRODUCT_ID_MISSING", { outcomeUnknown: true });
    return {
      externalId,
      externalUrl: null,
      providerResponse: {
        requestId: response.requestId,
        operation: "created",
        saveMode: config.saveMode ?? "AS_DRAFT",
        imageCount: uploadedImages.length,
        tiktokImageUploads: uploadedImages,
        skus: responseSkus(response.data.skus),
      },
    };
  } catch (error) {
    mapApiError(error);
  }
}

export async function recordTikTokShopMappings(input: {
  connectionId: string;
  productId: string;
  externalId: string;
  providerResponse: Record<string, unknown>;
  payload: Record<string, unknown>;
}) {
  const now = Date.now();
  const product = productSnapshot(input.productId, input.payload);
  const variantIds = new Set(product.variants.map((variant) => variant.id));
  const statements = [database().prepare(
    `INSERT INTO channel_mappings
     (id, workspace_id, connection_id, entity_type, entity_id, external_id, sync_status,
      last_synced_at, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, 'product', ?, ?, 'synced', ?, '{}', ?, ?)
     ON CONFLICT(connection_id, entity_type, entity_id) DO UPDATE SET
       external_id = excluded.external_id, sync_status = 'synced', last_synced_at = excluded.last_synced_at,
       updated_at = excluded.updated_at`,
  ).bind(crypto.randomUUID(), TAHA_WORKSPACE_ID, input.connectionId, input.productId, input.externalId, now, now, now)];
  const skus = responseSkus(input.providerResponse.skus);
  for (const sku of skus) {
    if (!sku.externalSkuId || !variantIds.has(sku.externalSkuId)) continue;
    statements.push(database().prepare(
      `INSERT INTO channel_mappings
       (id, workspace_id, connection_id, entity_type, entity_id, external_id, external_parent_id,
        sync_status, last_synced_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, 'variant', ?, ?, ?, 'synced', ?, '{}', ?, ?)
       ON CONFLICT(connection_id, entity_type, entity_id) DO UPDATE SET
         external_id = excluded.external_id, external_parent_id = excluded.external_parent_id,
         sync_status = 'synced', last_synced_at = excluded.last_synced_at, updated_at = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(), TAHA_WORKSPACE_ID, input.connectionId, sku.externalSkuId,
      sku.id, input.externalId, now, now, now,
    ));
  }
  try {
    await database().batch(statements);
    return true;
  } catch {
    return false;
  }
}
