import { mediaBlob } from "../media";
import { getConnectedIntegration, getGoogleAccessToken } from "./connection-secrets";
import { getRuntimeEnv } from "./env";
import {
  findGoogleDriveFileByAppProperty,
  GoogleDriveError,
  indexGoogleDriveAssets,
  markGoogleConnectionReauthRequired,
  normalizeSkuKey,
  requireGoogleDriveWriteScope,
  sanitizeGoogleDriveFilename,
  uploadGoogleDriveImage,
  type DriveFile,
  type DriveSkuAssets,
  type IndexedDriveFile,
} from "./google-drive";
import { TAHA_WORKSPACE_ID } from "./store";

const MAX_PRODUCT_SOURCE_IMAGES = 20;
const MAX_GOOGLE_IMAGE_EXPORT_BYTES = 25 * 1024 * 1024;

export type CatalogProduct = {
  sku: string;
  skuKey: string;
  name: string;
  brand: string | null;
  category: string | null;
  description: string;
  price: number;
  compareAtPrice: number | null;
  inventory: number;
  status: "draft" | "active" | "paused";
  rowNumber: number;
};

export type GoogleDriveImportInput = {
  connectionId?: unknown;
  productId?: unknown;
  mediaId?: unknown;
  filename?: unknown;
};

export type GoogleDriveImportResult = {
  connectionId: string;
  productId: string;
  mediaId: string;
  driveFileId: string;
  driveFolderId: string;
  filename: string;
  alreadyUploaded: boolean;
  uploadedAt: number;
};

function database() {
  const value = getRuntimeEnv().DB;
  if (!value) throw new Error("DATABASE_UNAVAILABLE");
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function safeJson(value: unknown) {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeHeader(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function slugify(value: string) {
  return normalizeHeader(value).replace(/\s+/g, "-") || crypto.randomUUID();
}

function parseMoney(value: unknown) {
  const digits = String(value ?? "").replace(/[^0-9-]/g, "");
  const numeric = Number(digits);
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
}

function valueFor(row: unknown[], headers: Map<string, number>, names: string[]) {
  for (const name of names) {
    const index = headers.get(name);
    if (index !== undefined && row[index] !== undefined) return row[index];
  }
  return "";
}

export function parseGoogleCatalogRows(rows: unknown[][]) {
  if (rows.length < 2) return [];
  const headers = new Map(rows[0].map((cell, index) => [normalizeHeader(cell), index]));
  return rows.slice(1).flatMap((row, index): CatalogProduct[] => {
    const sku = String(valueFor(row, headers, ["sku", "ma sku", "ma san pham"])).normalize("NFKC").trim();
    const skuKey = normalizeSkuKey(sku);
    const name = String(valueFor(row, headers, ["ten san pham", "san pham", "name", "product name"])).trim();
    if (!skuKey || !name) return [];
    const rawStatus = normalizeHeader(valueFor(row, headers, ["trang thai", "status"]));
    const status = rawStatus.includes("ready") || rawStatus.includes("active") || rawStatus.includes("san sang") ? "active" : rawStatus.includes("pause") || rawStatus.includes("tam dung") ? "paused" : "draft";
    const listPrice = parseMoney(valueFor(row, headers, ["gia ban", "gia"]));
    const salePrice = parseMoney(valueFor(row, headers, ["gia sale", "gia khuyen mai", "sale price", "discount price"]));
    const englishPrice = parseMoney(valueFor(row, headers, ["price"]));
    const englishCompareAtPrice = parseMoney(valueFor(row, headers, ["compare at price"]));
    const usesVietnamesePricing = listPrice > 0 || salePrice > 0;
    const hasVietnameseDiscount = listPrice > 0 && salePrice > 0 && salePrice < listPrice;
    const hasEnglishDiscount = englishPrice > 0 && englishCompareAtPrice > englishPrice;
    return [{
      sku,
      skuKey,
      name,
      brand: String(valueFor(row, headers, ["thuong hieu", "brand"])).trim() || null,
      category: String(valueFor(row, headers, ["danh muc", "category"])).trim() || null,
      description: String(valueFor(row, headers, ["mo ta", "mo ta that", "description"])).trim(),
      price: usesVietnamesePricing ? (hasVietnameseDiscount ? salePrice : listPrice || salePrice) : englishPrice,
      compareAtPrice: usesVietnamesePricing ? (hasVietnameseDiscount ? listPrice : null) : (hasEnglishDiscount ? englishCompareAtPrice : null),
      inventory: parseMoney(valueFor(row, headers, ["ton kho", "so luong", "inventory", "stock"])),
      status,
      rowNumber: index + 2,
    }];
  });
}

export function duplicateCatalogSkus(products: CatalogProduct[]) {
  const rowsBySku = new Map<string, number[]>();
  for (const product of products) rowsBySku.set(product.skuKey, [...(rowsBySku.get(product.skuKey) ?? []), product.rowNumber]);
  return [...rowsBySku.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([skuKey, rows]) => ({ skuKey, rows }));
}

async function googleSheetJson<T>(url: URL, token: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new GoogleDriveError("GOOGLE_SHEETS_UNAVAILABLE", "Không thể kết nối Google Sheets lúc này.", 503);
  }
  if (response.status === 401) throw new GoogleDriveError("GOOGLE_REAUTH_REQUIRED", "Google yêu cầu kết nối lại tài khoản.", 401);
  if (response.status === 403) throw new GoogleDriveError("GOOGLE_SHEETS_FORBIDDEN", "Tài khoản Google không có quyền đọc Sheet sản phẩm.", 403);
  if (response.status === 404) throw new GoogleDriveError("GOOGLE_SHEET_NOT_FOUND", "Không tìm thấy Google Sheet hoặc vùng Products.", 404);
  if (!response.ok) throw new GoogleDriveError("GOOGLE_SHEETS_REQUEST_FAILED", "Không thể đọc Google Sheet lúc này.", 502);
  return response.json() as Promise<T>;
}

type ProductSourceContext = {
  connectionId: string;
  sheetId: string;
  sheetRange: string;
  rootFolderId: string;
  assets: DriveSkuAssets;
  indexedAt: number;
};

async function upsertProduct(sourceExternalId: string, product: CatalogProduct, source: ProductSourceContext) {
  const now = source.indexedAt;
  const db = database();
  const legacySourceExternalId = `sheet:${source.sheetId}:sku:${product.sku}`;
  const existing = await db.prepare(
    `SELECT id, metadata_json FROM products
     WHERE workspace_id = ? AND deleted_at IS NULL AND (
       (source_connection_id = ? AND source_external_id IN (?, ?))
       OR ((source_connection_id IS NULL OR source_connection_id = ?) AND base_sku = ? COLLATE NOCASE)
     )
     ORDER BY CASE WHEN source_external_id = ? THEN 0 WHEN source_external_id = ? THEN 1 ELSE 2 END
     LIMIT 1`,
  ).bind(
    TAHA_WORKSPACE_ID,
    source.connectionId,
    sourceExternalId,
    legacySourceExternalId,
    source.connectionId,
    product.sku,
    sourceExternalId,
    legacySourceExternalId,
  ).first<{ id: string; metadata_json: string }>();
  const productId = existing?.id ?? crypto.randomUUID();
  const existingMetadata = safeJson(existing?.metadata_json);
  const metadata = JSON.stringify({
    ...existingMetadata,
    sheetRow: product.rowNumber,
    source: "google_sheets",
    googleSource: {
      connectionId: source.connectionId,
      sheetId: source.sheetId,
      sheetRange: source.sheetRange,
      rowNumber: product.rowNumber,
      sku: product.sku,
      skuKey: product.skuKey,
      driveRootFolderId: source.rootFolderId,
      driveFolderId: source.assets.targetFolderId,
      driveFolderName: source.assets.targetFolderName,
      driveFolderMatch: source.assets.targetKind,
      indexedAt: now,
    },
  });
  if (existing) {
    await db.prepare(
      `UPDATE products SET source_connection_id = ?, source_external_id = ?, name = ?, description = ?,
       brand = ?, category = ?, status = ?, metadata_json = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    ).bind(source.connectionId, sourceExternalId, product.name, product.description, product.brand, product.category, product.status, metadata, now, productId).run();
  } else {
    await db.prepare(
      `INSERT INTO products (id, workspace_id, source_connection_id, source_external_id, base_sku, name, slug,
       description, brand, category, currency, status, metadata_json, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VND', ?, ?, 1, ?, ?)`,
    ).bind(productId, TAHA_WORKSPACE_ID, source.connectionId, sourceExternalId, product.sku, product.name, slugify(`${product.sku}-${product.name}`), product.description, product.brand, product.category, product.status, metadata, now, now).run();
  }
  const variant = await db.prepare(
    "SELECT id FROM product_variants WHERE workspace_id = ? AND product_id = ? ORDER BY sort_order ASC LIMIT 1",
  ).bind(TAHA_WORKSPACE_ID, productId).first<{ id: string }>();
  if (variant) {
    await db.prepare("UPDATE product_variants SET price_minor = ?, compare_at_price_minor = ?, inventory_quantity = ?, updated_at = ? WHERE id = ?")
      .bind(product.price, product.compareAtPrice, product.inventory, now, variant.id).run();
  } else {
    await db.prepare(
      `INSERT INTO product_variants (id, workspace_id, product_id, sku, title, option_values_json, price_minor,
       compare_at_price_minor, inventory_quantity, sort_order, status, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Mặc định', '{}', ?, ?, ?, 0, 'active', '{}', ?, ?)`,
    ).bind(crypto.randomUUID(), TAHA_WORKSPACE_ID, productId, product.sku, product.price, product.compareAtPrice, product.inventory, now, now).run();
  }
  return productId;
}

function sourceMediaMetadata(existing: unknown, file: IndexedDriveFile, source: ProductSourceContext) {
  return JSON.stringify({
    ...safeJson(existing),
    name: file.name,
    modifiedTime: file.modifiedTime ?? null,
    md5Checksum: file.md5Checksum ?? null,
    googleDriveSource: {
      connectionId: source.connectionId,
      driveFileId: file.id,
      driveFolderId: file.sourceFolderId,
      driveRootFolderId: source.rootFolderId,
      driveFolderName: file.sourceFolderId === source.assets.targetFolderId ? source.assets.targetFolderName : null,
      skuKey: source.assets.skuKey,
      matchKind: file.matchKind,
    },
  });
}

async function attachAssets(productId: string, files: IndexedDriveFile[], source: ProductSourceContext) {
  const db = database();
  const now = source.indexedAt;
  const selectedFiles = files.slice(0, MAX_PRODUCT_SOURCE_IMAGES);
  const selectedMediaIds: string[] = [];
  for (const [index, file] of selectedFiles.entries()) {
    const existing = await db.prepare(
      `SELECT id, metadata_json FROM media_assets
       WHERE workspace_id = ? AND storage_provider = 'google_drive' AND external_id = ? LIMIT 1`,
    ).bind(TAHA_WORKSPACE_ID, file.id).first<{ id: string; metadata_json: string }>();
    const mediaId = existing?.id ?? crypto.randomUUID();
    const metadata = sourceMediaMetadata(existing?.metadata_json, file, source);
    if (existing) {
      await db.prepare(
        `UPDATE media_assets SET source_connection_id = ?, channel_id = 'google_drive', mime_type = ?, byte_size = ?,
         metadata_json = ?, status = 'ready', updated_at = ? WHERE id = ?`,
      ).bind(source.connectionId, file.mimeType, Number(file.size) || null, metadata, now, mediaId).run();
    } else {
      await db.prepare(
        `INSERT INTO media_assets (id, workspace_id, source_connection_id, channel_id, media_type, origin, storage_provider,
         external_id, mime_type, byte_size, alt_text, status, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, 'google_drive', 'image', 'source', 'google_drive', ?, ?, ?, ?, 'ready', ?, ?, ?)`,
      ).bind(mediaId, TAHA_WORKSPACE_ID, source.connectionId, file.id, file.mimeType, Number(file.size) || null, file.name, metadata, now, now).run();
    }
    const linked = await db.prepare("SELECT id FROM product_media WHERE product_id = ? AND media_id = ? LIMIT 1")
      .bind(productId, mediaId).first<{ id: string }>();
    if (linked) {
      await db.prepare("UPDATE product_media SET role = ?, sort_order = ? WHERE id = ?")
        .bind(index === 0 ? "primary" : "gallery", index, linked.id).run();
    } else {
      await db.prepare("INSERT INTO product_media (id, workspace_id, product_id, media_id, role, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), TAHA_WORKSPACE_ID, productId, mediaId, index === 0 ? "primary" : "gallery", index, now).run();
    }
    selectedMediaIds.push(mediaId);
  }

  const linkedAssets = await db.prepare(
    `SELECT pm.id, pm.media_id FROM product_media pm
     INNER JOIN media_assets media ON media.id = pm.media_id
     WHERE pm.workspace_id = ? AND pm.product_id = ? AND media.storage_provider = 'google_drive'
       AND media.source_connection_id = ?`,
  ).bind(TAHA_WORKSPACE_ID, productId, source.connectionId).all<{ id: string; media_id: string }>();
  const selected = new Set(selectedMediaIds);
  // Only reconcile deletions when the complete remote set fits within the local
  // attachment limit. If Drive contains more images, preserving older links is
  // safer than silently detaching valid media that merely fell outside the cap.
  const staleLinks = files.length <= MAX_PRODUCT_SOURCE_IMAGES
    ? (linkedAssets.results ?? []).filter((link) => !selected.has(link.media_id))
    : [];
  if (staleLinks.length) {
    await db.batch(staleLinks.map((link) => db.prepare("DELETE FROM product_media WHERE id = ? AND workspace_id = ?").bind(link.id, TAHA_WORKSPACE_ID)));
  }
  return { attached: selectedMediaIds.length, removed: staleLinks.length, skipped: Math.max(0, files.length - selectedFiles.length) };
}

function canonicalSourceExternalId(sheetId: string, skuKey: string) {
  return `sheet:${sheetId}:sku:${encodeURIComponent(skuKey)}`;
}

export async function syncGoogleCatalog(connectionId?: string) {
  const connection = await getConnectedIntegration<{ accessToken?: unknown; refreshToken?: unknown }>("google", connectionId);
  try {
    const token = await getGoogleAccessToken(connection);
    const folderId = String(connection.config.folderId || getRuntimeEnv().GOOGLE_DRIVE_FOLDER_ID || "");
    const sheetId = String(connection.config.sheetId || getRuntimeEnv().GOOGLE_SHEET_ID || "");
    const range = String(connection.config.sheetRange || getRuntimeEnv().GOOGLE_SHEET_RANGE || "Products!A:Z");
    if (!folderId || !sheetId) throw new GoogleDriveError("GOOGLE_SOURCE_NOT_CONFIGURED", "Chưa chọn thư mục Drive hoặc Google Sheet nguồn.", 409);

    const sheetUrl = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`);
    const sheet = await googleSheetJson<{ values?: unknown[][] }>(sheetUrl, token);
    const products = parseGoogleCatalogRows(sheet.values ?? []);
    const duplicateSkus = duplicateCatalogSkus(products);
    if (duplicateSkus.length) {
      throw new GoogleDriveError("GOOGLE_DUPLICATE_SHEET_SKUS", "Sheet Products có SKU trùng nhau; hãy giữ đúng một dòng cho mỗi SKU.", 422, duplicateSkus);
    }
    const driveIndex = await indexGoogleDriveAssets(folderId, products.map((product) => product.skuKey), token);
    const indexedAt = Date.now();
    let mediaCount = 0;
    let removedMediaLinks = 0;
    let skippedMedia = 0;
    let productsWithoutImages = 0;
    for (const product of products) {
      const assets = driveIndex.bySku.get(product.skuKey) ?? {
        skuKey: product.skuKey,
        targetFolderId: null,
        targetFolderName: null,
        targetKind: "none" as const,
        files: [],
      };
      const source: ProductSourceContext = {
        connectionId: connection.id,
        sheetId,
        sheetRange: range,
        rootFolderId: folderId,
        assets,
        indexedAt,
      };
      const productId = await upsertProduct(canonicalSourceExternalId(sheetId, product.skuKey), product, source);
      const attached = await attachAssets(productId, assets.files, source);
      mediaCount += attached.attached;
      removedMediaLinks += attached.removed;
      skippedMedia += attached.skipped;
      if (!assets.files.length) productsWithoutImages += 1;
    }
    const now = Date.now();
    const summary = {
      products: products.length,
      media: mediaCount,
      removedMediaLinks,
      skippedMedia,
      productsWithoutImages,
      matchedSkuFolders: driveIndex.matchedSkuFolders,
      matchedRootFiles: driveIndex.matchedRootFiles,
      unmatchedRootImages: driveIndex.unmatchedRootImages,
    };
    await database().batch([
      database().prepare("UPDATE channel_connections SET last_synced_at = ?, last_error = NULL, updated_at = ? WHERE id = ?").bind(now, now, connection.id),
      database().prepare(
        "INSERT INTO audit_logs (id, workspace_id, actor_type, actor_label, action, entity_type, entity_id, metadata_json, created_at) VALUES (?, ?, 'connector', 'Google Drive & Sheets', 'google.catalog_synced', 'channel_connection', ?, ?, ?)",
      ).bind(crypto.randomUUID(), TAHA_WORKSPACE_ID, connection.id, JSON.stringify(summary), now),
    ]);
    return { connectionId: connection.id, ...summary, syncedAt: now };
  } catch (error) {
    const code = error instanceof GoogleDriveError ? error.code : error instanceof Error ? error.message : "";
    if (code === "GOOGLE_REAUTH_REQUIRED" || code === "GOOGLE_WRITE_SCOPE_REQUIRED") {
      await markGoogleConnectionReauthRequired(connection.id, code).catch(() => undefined);
    }
    throw error;
  }
}

function validateRequiredId(value: unknown, label: string) {
  const id = nonEmptyString(value);
  if (!id || id.length > 128) throw new GoogleDriveError("INVALID_GOOGLE_DRIVE_IMPORT", `${label} không hợp lệ.`, 422);
  return id;
}

function requestedFilename(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim() || value.length > 180) {
    throw new GoogleDriveError("INVALID_GOOGLE_DRIVE_IMPORT", "Tên tệp Google Drive không hợp lệ.", 422);
  }
  return sanitizeGoogleDriveFilename(value);
}

function extensionForMimeType(mimeType: string) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "jpg";
}

type DriveExportRow = {
  product_id: string;
  base_sku: string;
  product_source_connection_id: string | null;
  product_metadata_json: string;
  media_id: string;
  media_origin: string;
  media_mime_type: string | null;
  media_metadata_json: string;
};

async function persistDriveExport(
  row: DriveExportRow,
  connectionId: string,
  folderId: string,
  file: DriveFile,
  alreadyUploaded: boolean,
  actorId: string | null,
) {
  const db = database();
  const now = Date.now();
  const metadata = safeJson(row.media_metadata_json);
  const exports = asRecord(metadata.googleDriveExports);
  const exportedAt = alreadyUploaded
    ? Number(asRecord(exports[connectionId]).uploadedAt) || now
    : now;
  const nextMetadata = JSON.stringify({
    ...metadata,
    googleDriveExports: {
      ...exports,
      [connectionId]: {
        connectionId,
        driveFileId: file.id,
        driveFolderId: folderId,
        filename: file.name,
        mimeType: file.mimeType,
        uploadedAt: exportedAt,
      },
    },
  });
  const statements = [
    db.prepare("UPDATE media_assets SET metadata_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
      .bind(nextMetadata, now, row.media_id, TAHA_WORKSPACE_ID),
    db.prepare("UPDATE channel_connections SET last_synced_at = ?, last_error = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?")
      .bind(now, now, connectionId, TAHA_WORKSPACE_ID),
  ];
  if (!alreadyUploaded) {
    const actorType = actorId && !actorId.startsWith("automation:") ? "user" : "system";
    statements.push(db.prepare(
      `INSERT INTO audit_logs
       (id, workspace_id, actor_type, actor_id, actor_label, action, entity_type, entity_id, metadata_json, created_at)
       VALUES (?, ?, ?, ?, 'Google Drive & Sheets', 'google.generated_image_uploaded', 'media_asset', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      TAHA_WORKSPACE_ID,
      actorType,
      actorId,
      row.media_id,
      JSON.stringify({ connectionId, productId: row.product_id, driveFileId: file.id, driveFolderId: folderId, filename: file.name }),
      now,
    ));
  }
  await db.batch(statements);
  return exportedAt;
}

export async function exportGeneratedImageToGoogleDrive(
  input: GoogleDriveImportInput,
  actorId: string | null = null,
): Promise<GoogleDriveImportResult> {
  const productId = validateRequiredId(input?.productId, "Sản phẩm");
  const mediaId = validateRequiredId(input?.mediaId, "Media");
  const connectionId = nonEmptyString(input?.connectionId) || undefined;
  if (connectionId && connectionId.length > 128) throw new GoogleDriveError("INVALID_GOOGLE_DRIVE_IMPORT", "Kết nối Google không hợp lệ.", 422);
  const filenameOverride = requestedFilename(input?.filename);
  const connection = await getConnectedIntegration<{ accessToken?: unknown; refreshToken?: unknown }>("google", connectionId);

  try {
    await requireGoogleDriveWriteScope(connection.id);
    const token = await getGoogleAccessToken(connection);
    const row = await database().prepare(
      `SELECT p.id AS product_id, p.base_sku, p.source_connection_id AS product_source_connection_id,
              p.metadata_json AS product_metadata_json, media.id AS media_id, media.origin AS media_origin,
              media.mime_type AS media_mime_type, media.metadata_json AS media_metadata_json
       FROM products p
       INNER JOIN product_media pm ON pm.product_id = p.id AND pm.workspace_id = p.workspace_id
       INNER JOIN media_assets media ON media.id = pm.media_id AND media.workspace_id = p.workspace_id
       WHERE p.workspace_id = ? AND p.id = ? AND p.deleted_at IS NULL AND media.id = ?
         AND media.status = 'ready' AND media.media_type = 'image' AND media.origin IN ('generated', 'derived')
       LIMIT 1`,
    ).bind(TAHA_WORKSPACE_ID, productId, mediaId).first<DriveExportRow>();
    if (!row) {
      throw new GoogleDriveError("GENERATED_MEDIA_NOT_FOUND", "Không tìm thấy ảnh generated đã liên kết với sản phẩm này.", 404);
    }
    if (row.product_source_connection_id && row.product_source_connection_id !== connection.id) {
      throw new GoogleDriveError("GOOGLE_PRODUCT_CONNECTION_MISMATCH", "Sản phẩm thuộc một kết nối Google khác.", 409);
    }
    const productMetadata = safeJson(row.product_metadata_json);
    const googleSource = asRecord(productMetadata.googleSource);
    if (nonEmptyString(googleSource.connectionId) !== connection.id) {
      throw new GoogleDriveError("GOOGLE_PRODUCT_SOURCE_MISSING", "Hãy đồng bộ Sheet Products trước khi tải ảnh về Drive.", 409);
    }
    const folderId = nonEmptyString(googleSource.driveFolderId);
    if (!folderId) {
      throw new GoogleDriveError("GOOGLE_SKU_FOLDER_NOT_FOUND", "SKU chưa có thư mục hoặc ảnh nguồn để xác định vị trí trên Drive.", 409);
    }

    const existingFile = await findGoogleDriveFileByAppProperty(token, folderId, "tahaMediaId", mediaId);
    if (existingFile) {
      const uploadedAt = await persistDriveExport(row, connection.id, folderId, existingFile, true, actorId);
      return {
        connectionId: connection.id,
        productId,
        mediaId,
        driveFileId: existingFile.id,
        driveFolderId: folderId,
        filename: existingFile.name,
        alreadyUploaded: true,
        uploadedAt,
      };
    }

    let loaded: Awaited<ReturnType<typeof mediaBlob>>;
    try {
      loaded = await mediaBlob(mediaId, MAX_GOOGLE_IMAGE_EXPORT_BYTES);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "MEDIA_TOO_LARGE") throw new GoogleDriveError("MEDIA_TOO_LARGE", "Ảnh vượt quá giới hạn 25 MB.", 413);
      if (code === "MEDIA_NOT_FOUND" || code === "MEDIA_OBJECT_MISSING") {
        throw new GoogleDriveError("GENERATED_MEDIA_NOT_FOUND", "Không tìm thấy nội dung ảnh generated.", 404);
      }
      throw error;
    }
    if (!loaded.mimeType.startsWith("image/")) throw new GoogleDriveError("GOOGLE_DRIVE_IMAGE_REQUIRED", "Media đã chọn không phải ảnh.", 415);
    const skuKey = normalizeSkuKey(row.base_sku);
    const defaultFilename = `${skuKey}-AI-${mediaId.slice(0, 8)}.${extensionForMimeType(loaded.mimeType)}`;
    const file = await uploadGoogleDriveImage({
      token,
      folderId,
      filename: filenameOverride ?? defaultFilename,
      mimeType: loaded.mimeType,
      blob: loaded.blob,
      appProperties: {
        tahaMediaId: mediaId,
        tahaProductId: productId,
        tahaSku: skuKey,
      },
    });
    const uploadedAt = await persistDriveExport(row, connection.id, folderId, file, false, actorId);
    return {
      connectionId: connection.id,
      productId,
      mediaId,
      driveFileId: file.id,
      driveFolderId: folderId,
      filename: file.name,
      alreadyUploaded: false,
      uploadedAt,
    };
  } catch (error) {
    const code = error instanceof GoogleDriveError ? error.code : error instanceof Error ? error.message : "";
    if (code === "GOOGLE_REAUTH_REQUIRED" || code === "GOOGLE_WRITE_SCOPE_REQUIRED") {
      await markGoogleConnectionReauthRequired(connection.id, code).catch(() => undefined);
    }
    throw error;
  }
}
