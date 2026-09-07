import { getRuntimeEnv } from "./integrations/env";
import { isCanonicalSkuFolderName, normalizeSkuKey } from "./integrations/google-drive";
import { TAHA_WORKSPACE_ID } from "./integrations/store";

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
export type SourceImage = { id: string; external_id: string; metadata_json: string; source_connection_id: string };

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
  const sku = normalizeSkuKey(product.base_sku);
  if (!sku || source.skuKey !== sku || source.connectionId !== product.source_connection_id
      || source.driveFolderMatch !== "sku_folder" || !source.driveFolderId
      || !isCanonicalSkuFolderName(source.driveFolderName, sku)) throw new Error("PRODUCT_SKU_FOLDER_MISMATCH");
  const rows = await db.prepare(`SELECT m.id, m.external_id, m.metadata_json, m.source_connection_id
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
