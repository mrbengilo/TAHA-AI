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

type ProductRow = {
  id: string;
  name: string;
  description: string;
  currency: string;
};

type VariantRow = {
  id: string;
  sku: string;
  price_minor: number;
  inventory_quantity: number;
};

type ProductMappingRow = { external_id: string };

type TikTokSkuResponse = {
  id: string;
  externalSkuId: string | null;
};

export type TikTokShopRemoteInput = {
  connectionId: string;
  jobId: string;
  productId: string;
  payload: Record<string, unknown>;
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

async function productSnapshot(productId: string): Promise<TikTokProductSnapshot> {
  const product = await database().prepare(
    `SELECT id, name, description, currency FROM products
     WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND status != 'archived' LIMIT 1`,
  ).bind(productId, TAHA_WORKSPACE_ID).first<ProductRow>();
  if (!product) throw new PublishDeliveryError("TIKTOK_PRODUCT_NOT_FOUND");
  const variants = await database().prepare(
    `SELECT id, sku, price_minor, inventory_quantity FROM product_variants
     WHERE product_id = ? AND workspace_id = ? AND status = 'active'
     ORDER BY sort_order ASC, created_at ASC`,
  ).bind(productId, TAHA_WORKSPACE_ID).all<VariantRow>();
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    currency: product.currency,
    variants: (variants.results ?? []).map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      priceMinor: Number(variant.price_minor),
      inventoryQuantity: Number(variant.inventory_quantity),
    })),
  };
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
    const product = await productSnapshot(input.productId);
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

    const accessToken = await getTikTokShopAccessToken(connection);
    const uploadedImages: Awaited<ReturnType<typeof uploadTikTokShopProductImage>>[] = [];
    for (const mediaId of selectedMediaIds) {
      const media = await mediaBlob(mediaId, 10 * 1024 * 1024);
      if (!["image/jpeg", "image/png", "image/webp"].includes(media.mimeType.toLowerCase())) {
        throw new PublishDeliveryError("TIKTOK_IMAGE_TYPE_UNSUPPORTED");
      }
      uploadedImages.push(await uploadTikTokShopProductImage({
        accessToken,
        blob: media.blob,
        filename: media.filename,
      }));
    }

    const body = buildTikTokCreateProductBody({
      product,
      config,
      imageUris: uploadedImages.map((image) => image.uri),
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
}) {
  const now = Date.now();
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
    if (!sku.externalSkuId) continue;
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
