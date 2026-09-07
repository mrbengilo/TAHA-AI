import { getRuntimeEnv } from "./integrations/env";
import { isCanonicalSkuFolderName, normalizeSkuKey } from "./integrations/google-drive";
import { TAHA_WORKSPACE_ID } from "./integrations/store";
import { GENERATED_IMAGE_MAX_BYTES, IMAGE_COMPRESSION_POLICY, LIFESTYLE_PROMPT_VERSION, LIFESTYLE_VARIANTS, ORIGINAL_IMAGE_MAX_BYTES } from "./image-compression";

type Statement = {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results?: T[] }>;
};
export type ProductDatabase = { prepare(query: string): Statement };
export type SourceProduct = {
  id: string; base_sku: string; name: string; description: string;
  brand: string | null; category: string | null; currency: string;
  price_minor: number; compare_at_price_minor: number | null; inventory_quantity: number;
  source_connection_id: string; metadata_json: string;
};
export type SourceImage = {
  id: string; external_id: string; metadata_json: string; source_connection_id: string;
  mime_type: string | null; byte_size: number | null;
};

export function objectJson(value: string | null): Record<string, unknown> {
  try { const parsed = JSON.parse(value || "{}"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function productSourceConnection(productId: string, override?: ProductDatabase) {
  const db = override ?? getRuntimeEnv().DB;
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  const row = await db.prepare("SELECT source_connection_id FROM products WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL")
    .bind(productId, TAHA_WORKSPACE_ID).first<{ source_connection_id: string | null }>();
  if (!row?.source_connection_id) throw new Error("PRODUCT_SKU_FOLDER_MISMATCH");
  return row.source_connection_id;
}

export async function productSources(productId: string, override?: ProductDatabase) {
  const db = override ?? getRuntimeEnv().DB;
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  const product = await db.prepare(`SELECT p.id, p.base_sku, p.name, p.description, p.brand, p.category,
    p.currency, p.source_connection_id, p.metadata_json,
    COALESCE(MIN(v.price_minor), 0) AS price_minor, MAX(v.compare_at_price_minor) AS compare_at_price_minor,
    COALESCE(SUM(v.inventory_quantity), 0) AS inventory_quantity
    FROM products p LEFT JOIN product_variants v ON v.product_id = p.id AND v.workspace_id = p.workspace_id AND v.status = 'active'
    WHERE p.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL AND p.status = 'active'
    GROUP BY p.id LIMIT 1`).bind(productId, TAHA_WORKSPACE_ID).first<SourceProduct>();
  if (!product) throw new Error("PRODUCT_NOT_ACTIVE");
  const source = record(objectJson(product.metadata_json).googleSource);
  const connection = await db.prepare("SELECT config_json FROM channel_connections WHERE id = ? AND workspace_id = ? AND provider = 'google'")
    .bind(product.source_connection_id, TAHA_WORKSPACE_ID).first<{ config_json: string }>();
  const config = objectJson(connection?.config_json ?? null);
  const runtime = getRuntimeEnv();
  if (!connection || source.sheetId !== (config.sheetId || runtime.GOOGLE_SHEET_ID || "")
    || source.sheetRange !== (config.sheetRange || runtime.GOOGLE_SHEET_RANGE || "Products!A:Z")
    || source.driveRootFolderId !== (config.folderId || runtime.GOOGLE_DRIVE_FOLDER_ID || "")
    || ((source.syncId || config._catalogSyncComplete) && (typeof source.syncId !== "string" || !source.syncId || source.syncId !== config._catalogSyncComplete))) throw new Error("PRODUCT_SOURCE_CHANGED");
  const sku = normalizeSkuKey(product.base_sku);
  if (!sku || source.skuKey !== sku || source.connectionId !== product.source_connection_id
      || source.driveFolderMatch !== "sku_folder" || !source.driveFolderId
      || !isCanonicalSkuFolderName(source.driveFolderName, sku)) throw new Error("PRODUCT_SKU_FOLDER_MISMATCH");
  const rows = await db.prepare(`SELECT m.id, m.external_id, m.metadata_json, m.source_connection_id, m.mime_type, m.byte_size
    FROM product_media pm JOIN media_assets m ON m.id = pm.media_id AND m.workspace_id = pm.workspace_id
    WHERE pm.product_id = ? AND pm.workspace_id = ? AND m.media_type = 'image'
      AND m.origin = 'source' AND m.storage_provider = 'google_drive' AND m.status = 'ready'
    ORDER BY CASE pm.role WHEN 'primary' THEN 0 ELSE 1 END, pm.sort_order, pm.created_at
    LIMIT 100`).bind(productId, TAHA_WORKSPACE_ID).all<SourceImage>();
  const seen = new Set<string>();
  const images = (rows.results ?? []).filter((image) => {
    if (seen.has(image.id)) return false;
    seen.add(image.id);
    const mediaSource = record(objectJson(image.metadata_json).googleDriveSource);
    return image.source_connection_id === product.source_connection_id && image.external_id
      && mediaSource.driveFileId === image.external_id && mediaSource.skuKey === sku
      && mediaSource.connectionId === source.connectionId && mediaSource.matchKind === "sku_folder"
      && mediaSource.driveFolderId === source.driveFolderId;
  });
  if (!images.length) throw new Error("SKU_SOURCE_IMAGES_REQUIRED");
  return { product, images, source, sku };
}

export async function productFingerprint(product: SourceProduct) {
  // Exclude timestamps/inventory: an unchanged sync or stock movement must not invalidate a caption.
  const bytes = new TextEncoder().encode(JSON.stringify([
    product.base_sku, product.name, product.description, product.brand, product.category,
    product.currency, product.price_minor, product.compare_at_price_minor,
  ]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (v) => v.toString(16).padStart(2, "0")).join("");
}

export async function assertProductMedia(productId: string, mediaIds: string[], fingerprint?: string, db?: ProductDatabase) {
  const sources = await productSources(productId, db);
  const allowed = new Set(sources.images.map((image) => image.id));
  if (!mediaIds.length || mediaIds.length > 10 || new Set(mediaIds).size !== mediaIds.length
      || mediaIds.some((id) => !allowed.has(id))) throw new Error("PRODUCT_MEDIA_MISMATCH");
  if (fingerprint && fingerprint !== await productFingerprint(sources.product)) throw new Error("PRODUCT_CONTENT_STALE");
  return sources;
}

type GeneratedImage = SourceImage & { origin: string; storage_provider: string; product_id: string; role: string };

export async function assertGeneratedProductMedia(
  productId: string,
  mediaIds: string[],
  fingerprint: string,
  promptVersion: string,
  variants: readonly string[],
  override?: ProductDatabase,
) {
  const db = override ?? getRuntimeEnv().DB;
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  const sources = await productSources(productId, db);
  if (fingerprint !== await productFingerprint(sources.product) || mediaIds.length !== variants.length
    || mediaIds.length < 1 || mediaIds.length > LIFESTYLE_VARIANTS.length
    || new Set(mediaIds).size !== mediaIds.length) throw new Error("PRODUCT_GENERATED_MEDIA_MISMATCH");
  const placeholders = mediaIds.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT m.id, m.external_id, m.metadata_json, m.source_connection_id,
      m.mime_type, m.byte_size, m.origin, m.storage_provider, pm.product_id, pm.role
    FROM media_assets m JOIN product_media pm ON pm.media_id = m.id AND pm.workspace_id = m.workspace_id
    WHERE m.workspace_id = ? AND pm.product_id = ? AND m.id IN (${placeholders})
      AND m.status = 'ready' ORDER BY m.id`)
    .bind(TAHA_WORKSPACE_ID, productId, ...mediaIds).all<GeneratedImage>();
  const byId = new Map((rows.results ?? []).map((row) => [row.id, row]));
  if ((rows.results ?? []).length !== mediaIds.length) throw new Error("PRODUCT_GENERATED_MEDIA_MISMATCH");
  const sourceIds = new Set(sources.images.map((image) => image.id));
  for (let index = 0; index < mediaIds.length; index += 1) {
    const row = byId.get(mediaIds[index]);
    const metadata = record(objectJson(row?.metadata_json ?? null));
    const drive = record(metadata.googleDriveSource);
    const generation = record(metadata.generation);
    const source = sources.images.find((image) => image.id === String(generation.sourceMediaId || ""));
    const sourceMetadata = source ? record(objectJson(source.metadata_json)) : {};
    const sourceVersion = String(sourceMetadata.md5Checksum || sourceMetadata.modifiedTime || "");
    if (!row || row.origin !== "generated" || row.storage_provider !== "google_drive" || row.role !== "generated"
      || row.source_connection_id !== sources.product.source_connection_id || !row.external_id
      || row.mime_type !== "image/jpeg" || !row.byte_size || row.byte_size >= GENERATED_IMAGE_MAX_BYTES
      || drive.driveFileId !== row.external_id || drive.driveFolderId !== sources.source.driveFolderId
      || drive.connectionId !== sources.source.connectionId || drive.skuKey !== sources.sku
      || generation.variant !== variants[index] || generation.sourceFingerprint !== fingerprint
      || generation.promptVersion !== promptVersion || generation.compressionPolicy !== IMAGE_COMPRESSION_POLICY
      || !sourceIds.has(String(generation.sourceMediaId || "")) || generation.sourceExternalId !== source?.external_id
      || !sourceVersion || generation.sourceVersion !== sourceVersion) throw new Error("PRODUCT_GENERATED_MEDIA_MISMATCH");
  }
  return sources;
}

export async function verifiedProductGeneratedImages(productId: string, override?: ProductDatabase) {
  const db = override ?? getRuntimeEnv().DB;
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  const sources = await productSources(productId, db);
  const fingerprint = await productFingerprint(sources.product);
  const rows = await db.prepare(`SELECT m.id, m.external_id, m.metadata_json, m.source_connection_id,
      m.mime_type, m.byte_size, m.origin, m.storage_provider, pm.product_id, pm.role
    FROM media_assets m JOIN product_media pm ON pm.media_id=m.id AND pm.workspace_id=m.workspace_id
    WHERE m.workspace_id=? AND pm.product_id=? AND pm.role='generated' AND m.origin='generated'
      AND m.status='ready' AND json_extract(m.metadata_json, '$.generation.sourceFingerprint')=?
      AND json_extract(m.metadata_json, '$.generation.promptVersion')=?
      AND json_extract(m.metadata_json, '$.generation.compressionPolicy')=?`)
    .bind(TAHA_WORKSPACE_ID, productId, fingerprint, LIFESTYLE_PROMPT_VERSION, IMAGE_COMPRESSION_POLICY).all<GeneratedImage>();
  const byVariant = new Map<string, GeneratedImage>();
  for (const row of rows.results ?? []) {
    const generation = record(objectJson(row.metadata_json).generation);
    const source = sources.images.find((image) => image.id === String(generation.sourceMediaId || ""));
    const sourceMetadata = source ? record(objectJson(source.metadata_json)) : {};
    const sourceVersion = String(sourceMetadata.md5Checksum || sourceMetadata.modifiedTime || "");
    if (!source || generation.sourceExternalId !== source.external_id || !sourceVersion || generation.sourceVersion !== sourceVersion) continue;
    const variant = String(generation.variant || "");
    if (!LIFESTYLE_VARIANTS.includes(variant as typeof LIFESTYLE_VARIANTS[number]) || byVariant.has(variant)) return [];
    byVariant.set(variant, row);
  }
  const ordered: GeneratedImage[] = [];
  for (const variant of LIFESTYLE_VARIANTS) {
    const row = byVariant.get(variant);
    if (!row) break;
    ordered.push(row);
  }
  if (!ordered.length || ordered.length !== byVariant.size) return [];
  await assertGeneratedProductMedia(productId, ordered.map((row) => row.id), fingerprint,
    LIFESTYLE_PROMPT_VERSION, LIFESTYLE_VARIANTS.slice(0, ordered.length), db);
  return ordered;
}

export async function verifiedProductOptimizedImages(productId: string, override?: ProductDatabase) {
  const db = override ?? getRuntimeEnv().DB;
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  const sources = await productSources(productId, db);
  const sourceById = new Map(sources.images.map((image) => [image.id, image]));
  const rows = await db.prepare(`SELECT m.id, m.external_id, m.metadata_json, m.source_connection_id,
      m.mime_type, m.byte_size, m.origin, m.storage_provider, pm.product_id, pm.role
    FROM media_assets m JOIN product_media pm ON pm.media_id=m.id AND pm.workspace_id=m.workspace_id
    WHERE m.workspace_id=? AND pm.product_id=? AND m.origin='derived' AND m.storage_provider='google_drive'
      AND m.status='ready' AND m.byte_size > 0 AND m.byte_size < ?
      AND json_extract(m.metadata_json, '$.optimization.policy')=? ORDER BY pm.sort_order, m.id`)
    .bind(TAHA_WORKSPACE_ID, productId, ORIGINAL_IMAGE_MAX_BYTES, IMAGE_COMPRESSION_POLICY).all<GeneratedImage>();
  const verified: Array<GeneratedImage & { source_media_id: string }> = [];
  const seen = new Set<string>();
  for (const row of rows.results ?? []) {
    const metadata = record(objectJson(row.metadata_json));
    const optimization = record(metadata.optimization);
    const drive = record(metadata.googleDriveSource);
    const sourceId = String(optimization.sourceMediaId || "");
    const source = sourceById.get(sourceId);
    const sourceMetadata = source ? record(objectJson(source.metadata_json)) : {};
    const version = String(sourceMetadata.md5Checksum || sourceMetadata.modifiedTime || "");
    if (!source || seen.has(sourceId) || row.source_connection_id !== sources.product.source_connection_id
      || row.mime_type !== "image/jpeg" || !row.byte_size || row.byte_size >= ORIGINAL_IMAGE_MAX_BYTES
      || row.role !== "source" || !row.external_id || drive.driveFileId !== row.external_id
      || drive.driveFolderId !== sources.source.driveFolderId || drive.connectionId !== sources.source.connectionId
      || drive.skuKey !== sources.sku || optimization.sourceExternalId !== source.external_id
      || optimization.sourceVersion !== version) continue;
    seen.add(sourceId);
    verified.push({ ...row, source_media_id: sourceId });
  }
  return verified;
}
