import { getRuntimeEnv } from "./env";
import { getConnectedIntegration, getGoogleAccessToken } from "./connection-secrets";
import { TAHA_WORKSPACE_ID } from "./store";

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  parents?: string[];
};

type CatalogProduct = {
  sku: string;
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

function database() {
  const value = getRuntimeEnv().DB;
  if (!value) throw new Error("DATABASE_UNAVAILABLE");
  return value;
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
    const sku = String(valueFor(row, headers, ["sku", "ma sku", "ma san pham"])).trim();
    const name = String(valueFor(row, headers, ["ten san pham", "san pham", "name", "product name"])).trim();
    if (!sku || !name) return [];
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

async function googleJson<T>(url: URL, token: string): Promise<T> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`GOOGLE_API_${response.status}`);
  return response.json() as Promise<T>;
}

async function listChildren(folderId: string, token: string) {
  const files: DriveFile[] = [];
  let pageToken = "";
  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`);
    url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum,parents)");
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("orderBy", "name");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await googleJson<{ files?: DriveFile[]; nextPageToken?: string }>(url, token);
    files.push(...(data.files ?? []));
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return files;
}

async function loadDriveAssets(folderId: string, token: string) {
  const direct = await listChildren(folderId, token);
  const folders = direct.filter((file) => file.mimeType === "application/vnd.google-apps.folder");
  const assets = new Map<string, DriveFile[]>();
  const directImages = direct.filter((file) => file.mimeType.startsWith("image/"));
  if (directImages.length) assets.set("_root", directImages);
  for (const folder of folders.slice(0, 200)) {
    assets.set(folder.name.trim().toUpperCase(), (await listChildren(folder.id, token)).filter((file) => file.mimeType.startsWith("image/")));
  }
  return assets;
}

async function upsertProduct(connectionId: string, sourceExternalId: string, product: CatalogProduct) {
  const now = Date.now();
  const db = database();
  const existing = await db.prepare("SELECT id FROM products WHERE workspace_id = ? AND base_sku = ? LIMIT 1").bind(TAHA_WORKSPACE_ID, product.sku).first<{ id: string }>();
  const productId = existing?.id ?? crypto.randomUUID();
  const metadata = JSON.stringify({ sheetRow: product.rowNumber, source: "google_sheets" });
  if (existing) {
    await db.prepare(
      `UPDATE products SET source_connection_id = ?, source_external_id = ?, name = ?, description = ?,
       brand = ?, category = ?, status = ?, metadata_json = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    ).bind(connectionId, sourceExternalId, product.name, product.description, product.brand, product.category, product.status, metadata, now, productId).run();
  } else {
    await db.prepare(
      `INSERT INTO products (id, workspace_id, source_connection_id, source_external_id, base_sku, name, slug,
       description, brand, category, currency, status, metadata_json, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VND', ?, ?, 1, ?, ?)`,
    ).bind(productId, TAHA_WORKSPACE_ID, connectionId, sourceExternalId, product.sku, product.name, slugify(`${product.sku}-${product.name}`), product.description, product.brand, product.category, product.status, metadata, now, now).run();
  }
  const variant = await db.prepare("SELECT id FROM product_variants WHERE workspace_id = ? AND sku = ? LIMIT 1").bind(TAHA_WORKSPACE_ID, product.sku).first<{ id: string }>();
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

async function attachAssets(connectionId: string, productId: string, files: DriveFile[]) {
  const db = database();
  const now = Date.now();
  let count = 0;
  for (const [index, file] of files.slice(0, 20).entries()) {
    const existing = await db.prepare("SELECT id FROM media_assets WHERE workspace_id = ? AND storage_provider = 'google_drive' AND external_id = ? LIMIT 1")
      .bind(TAHA_WORKSPACE_ID, file.id).first<{ id: string }>();
    const mediaId = existing?.id ?? crypto.randomUUID();
    const metadata = JSON.stringify({ name: file.name, modifiedTime: file.modifiedTime ?? null, md5Checksum: file.md5Checksum ?? null });
    if (existing) {
      await db.prepare("UPDATE media_assets SET source_connection_id = ?, mime_type = ?, byte_size = ?, metadata_json = ?, status = 'ready', updated_at = ? WHERE id = ?")
        .bind(connectionId, file.mimeType, Number(file.size) || null, metadata, now, mediaId).run();
    } else {
      await db.prepare(
        `INSERT INTO media_assets (id, workspace_id, source_connection_id, media_type, origin, storage_provider,
         external_id, mime_type, byte_size, alt_text, status, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, 'image', 'source', 'google_drive', ?, ?, ?, ?, 'ready', ?, ?, ?)`,
      ).bind(mediaId, TAHA_WORKSPACE_ID, connectionId, file.id, file.mimeType, Number(file.size) || null, file.name, metadata, now, now).run();
    }
    const linked = await db.prepare("SELECT id FROM product_media WHERE product_id = ? AND media_id = ? LIMIT 1").bind(productId, mediaId).first<{ id: string }>();
    if (!linked) {
      await db.prepare("INSERT INTO product_media (id, workspace_id, product_id, media_id, role, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), TAHA_WORKSPACE_ID, productId, mediaId, index === 0 ? "primary" : "gallery", index, now).run();
    }
    count += 1;
  }
  return count;
}

export async function syncGoogleCatalog(connectionId?: string) {
  const connection = await getConnectedIntegration<{ accessToken?: unknown; refreshToken?: unknown }>("google", connectionId);
  const token = await getGoogleAccessToken(connection);
  const folderId = String(connection.config.folderId || getRuntimeEnv().GOOGLE_DRIVE_FOLDER_ID || "");
  const sheetId = String(connection.config.sheetId || getRuntimeEnv().GOOGLE_SHEET_ID || "");
  const range = String(connection.config.sheetRange || getRuntimeEnv().GOOGLE_SHEET_RANGE || "Products!A:Z");
  if (!folderId || !sheetId) throw new Error("GOOGLE_SOURCE_NOT_CONFIGURED");

  const sheetUrl = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`);
  const sheet = await googleJson<{ values?: unknown[][] }>(sheetUrl, token);
  const products = parseGoogleCatalogRows(sheet.values ?? []);
  const driveAssets = await loadDriveAssets(folderId, token);
  let mediaCount = 0;
  for (const product of products) {
    const productId = await upsertProduct(connection.id, `sheet:${sheetId}:sku:${product.sku}`, product);
    const files = driveAssets.get(product.sku.toUpperCase()) ?? [];
    mediaCount += await attachAssets(connection.id, productId, files);
  }
  const now = Date.now();
  await database().batch([
    database().prepare("UPDATE channel_connections SET last_synced_at = ?, last_error = NULL, updated_at = ? WHERE id = ?").bind(now, now, connection.id),
    database().prepare(
      "INSERT INTO audit_logs (id, workspace_id, actor_type, actor_label, action, entity_type, entity_id, metadata_json, created_at) VALUES (?, ?, 'connector', 'Google Drive & Sheets', 'google.catalog_synced', 'channel_connection', ?, ?, ?)",
    ).bind(crypto.randomUUID(), TAHA_WORKSPACE_ID, connection.id, JSON.stringify({ products: products.length, media: mediaCount }), now),
  ]);
  return { connectionId: connection.id, products: products.length, media: mediaCount, syncedAt: now };
}
