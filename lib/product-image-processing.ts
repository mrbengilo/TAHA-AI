import { compressImageToJpeg, GENERATED_IMAGE_MAX_BYTES, IMAGE_COMPRESSION_POLICY, LIFESTYLE_VARIANTS, ORIGINAL_IMAGE_MAX_BYTES } from "./image-compression";
import { originalMediaBlob, verifyOriginalMedia } from "./media";
import { productFingerprint, productSources, type SourceImage } from "./product-integrity";
import { getConnectedIntegration, getGoogleAccessToken } from "./integrations/connection-secrets";
import { downloadGoogleDriveImage, findGoogleDriveFileByAppProperty, normalizeSkuKey, requireGoogleDriveWriteScope, uploadGoogleDriveImage, type DriveFile } from "./integrations/google-drive";
import { getRuntimeEnv } from "./integrations/env";
import { TAHA_WORKSPACE_ID } from "./integrations/store";

export { LIFESTYLE_VARIANTS } from "./image-compression";

type MediaOrigin = "generated" | "derived";
type PersistInput = {
  productId: string;
  mediaId: string;
  linkId: string;
  origin: MediaOrigin;
  role: "generated" | "source";
  filename: string;
  maxBytes: number;
  blob?: Blob;
  details: Record<string, unknown>;
  appProperties: Record<string, string>;
  sortOrder: number;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function database() {
  const db = getRuntimeEnv().DB;
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  return db;
}

async function digestHex(value: string | ArrayBuffer) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((item) => item.toString(16).padStart(2, "0")).join("");
}

async function stableId(namespace: string, value: string) {
  return `${namespace}_${(await digestHex(value)).slice(0, 40)}`;
}

function sourceVersion(image: SourceImage) {
  const metadata = record(JSON.parse(image.metadata_json || "{}"));
  const version = String(metadata.md5Checksum || metadata.modifiedTime || "");
  if (!version) throw new Error("SOURCE_IMAGE_VERSION_MISSING");
  return version;
}

async function driveContext(productId: string) {
  const sources = await productSources(productId);
  const connection = await getConnectedIntegration<{ accessToken?: unknown; refreshToken?: unknown }>("google", sources.product.source_connection_id);
  if (connection.id !== sources.product.source_connection_id) throw new Error("PRODUCT_SOURCE_CHANGED");
  await requireGoogleDriveWriteScope(connection.id);
  const token = await getGoogleAccessToken(connection);
  return { sources, token, folderId: String(sources.source.driveFolderId), connectionId: connection.id };
}

function validateDriveFile(file: DriveFile, input: PersistInput, folderId: string) {
  const size = Number(file.size);
  if (!file.id || file.trashed || file.mimeType !== "image/jpeg" || !file.parents?.includes(folderId)
    || !Number.isFinite(size) || size < 1 || size >= input.maxBytes
    || Object.entries(input.appProperties).some(([key, value]) => file.appProperties?.[key] !== value)) {
    throw new Error("PRODUCT_DRIVE_MEDIA_MISMATCH");
  }
}

async function persistRow(input: PersistInput, context: Awaited<ReturnType<typeof driveContext>>, file: DriveFile, blob: Blob) {
  validateDriveFile(file, input, context.folderId);
  if (blob.type !== "image/jpeg" || blob.size < 1 || blob.size >= input.maxBytes || blob.size !== Number(file.size)) {
    throw new Error("PRODUCT_DRIVE_MEDIA_MISMATCH");
  }
  const db = database();
  const existing = await db.prepare(`SELECT id, workspace_id, source_connection_id, origin, storage_provider, external_id, metadata_json
    FROM media_assets WHERE id = ? OR (workspace_id = ? AND storage_provider = 'google_drive' AND external_id = ?)`)
    .bind(input.mediaId, TAHA_WORKSPACE_ID, file.id).all<Record<string, unknown>>();
  for (const row of existing.results ?? []) {
    if (row.id !== input.mediaId || row.workspace_id !== TAHA_WORKSPACE_ID || row.source_connection_id !== context.connectionId
      || row.origin !== input.origin || row.storage_provider !== "google_drive"
      || (row.external_id && row.external_id !== file.id)) throw new Error("PRODUCT_DRIVE_MEDIA_COLLISION");
  }
  const now = Date.now();
  const sha256 = await digestHex(await blob.arrayBuffer());
  const prior = record(JSON.parse(String((existing.results ?? []).find((row) => row.id === input.mediaId)?.metadata_json || "{}")));
  const details = input.origin === "generated"
    ? { generation: { ...record(prior.generation), ...record(input.details.generation) } }
    : { optimization: { ...record(prior.optimization), ...record(input.details.optimization) } };
  const metadataObject = {
    ...prior,
    name: file.name,
    md5Checksum: file.md5Checksum ?? null,
    modifiedTime: file.modifiedTime ?? null,
    googleDriveSource: {
      connectionId: context.connectionId,
      driveFileId: file.id,
      driveFolderId: context.folderId,
      driveRootFolderId: context.sources.source.driveRootFolderId,
      driveFolderName: context.sources.source.driveFolderName,
      skuKey: context.sources.sku,
      matchKind: "sku_folder",
    },
    ...details,
  };
  const metadata = JSON.stringify(metadataObject);
  await db.batch([
    db.prepare(`INSERT INTO media_assets
      (id, workspace_id, source_connection_id, channel_id, media_type, origin, storage_provider, external_id,
       mime_type, byte_size, sha256, alt_text, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, 'google_drive', 'image', ?, 'google_drive', ?, 'image/jpeg', ?, ?, ?, 'ready', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET external_id=excluded.external_id, mime_type=excluded.mime_type,
       byte_size=excluded.byte_size, sha256=excluded.sha256, status='ready', metadata_json=excluded.metadata_json,
       error_message=NULL, updated_at=excluded.updated_at
      WHERE media_assets.workspace_id=excluded.workspace_id AND media_assets.source_connection_id=excluded.source_connection_id
       AND media_assets.origin=excluded.origin AND media_assets.storage_provider='google_drive'
       AND (media_assets.external_id IS NULL OR media_assets.external_id=excluded.external_id)`)
      .bind(input.mediaId, TAHA_WORKSPACE_ID, context.connectionId, input.origin, file.id, blob.size, sha256, input.filename, metadata, now, now),
    db.prepare(`INSERT INTO product_media (id, workspace_id, product_id, media_id, role, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .bind(input.linkId, TAHA_WORKSPACE_ID, input.productId, input.mediaId, input.role, input.sortOrder, now),
  ]);
  const linked = await db.prepare(`SELECT pm.product_id, pm.role, m.external_id, m.status FROM product_media pm
    JOIN media_assets m ON m.id=pm.media_id AND m.workspace_id=pm.workspace_id
    WHERE pm.id=? AND pm.workspace_id=? AND pm.media_id=? LIMIT 1`)
    .bind(input.linkId, TAHA_WORKSPACE_ID, input.mediaId).first<{ product_id: string; role: string; external_id: string; status: string }>();
  if (!linked || linked.product_id !== input.productId || linked.role !== input.role || linked.external_id !== file.id || linked.status !== "ready") {
    throw new Error("PRODUCT_DRIVE_MEDIA_COLLISION");
  }
  return { mediaId: input.mediaId, file, byteSize: blob.size, sha256, metadata: metadataObject };
}

async function findOrPersist(input: PersistInput, suppliedContext?: Awaited<ReturnType<typeof driveContext>>) {
  const context = suppliedContext ?? await driveContext(input.productId);
  const existing = await findGoogleDriveFileByAppProperty(context.token, context.folderId, "tahaMediaId", input.mediaId);
  if (existing) {
    validateDriveFile(existing, input, context.folderId);
    const downloaded = await downloadGoogleDriveImage(context.token, existing.id, context.folderId, input.maxBytes);
    return persistRow(input, context, downloaded.file, downloaded.blob);
  }
  if (!input.blob) return null;
  if (input.blob.type !== "image/jpeg" || input.blob.size < 1 || input.blob.size >= input.maxBytes) throw new Error("IMAGE_COMPRESSION_TARGET_UNREACHABLE");
  const file = await uploadGoogleDriveImage({
    token: context.token,
    folderId: context.folderId,
    filename: input.filename,
    mimeType: "image/jpeg",
    blob: input.blob,
    appProperties: input.appProperties,
  });
  return persistRow(input, context, file, input.blob);
}

export async function generatedMediaIdentity(productId: string, source: SourceImage, fingerprint: string, variant: string, promptVersion: string) {
  const identity = [productId, fingerprint, source.id, source.external_id, sourceVersion(source), variant, promptVersion, IMAGE_COMPRESSION_POLICY].join(":");
  return { mediaId: await stableId("media", identity), linkId: await stableId("pm", identity) };
}

export async function findOrPersistGeneratedImage(input: {
  productId: string;
  source: SourceImage;
  sourceFingerprint: string;
  variant: string;
  promptVersion: string;
  model?: string;
  blob?: Blob;
  width?: number;
  height?: number;
}) {
  const variantIndex = LIFESTYLE_VARIANTS.indexOf(input.variant as typeof LIFESTYLE_VARIANTS[number]);
  if (variantIndex < 0) throw new Error("IMAGE_VARIANT_INVALID");
  const identity = await generatedMediaIdentity(input.productId, input.source, input.sourceFingerprint, input.variant, input.promptVersion);
  const sku = normalizeSkuKey((await productSources(input.productId)).product.base_sku);
  return findOrPersist({
    ...identity,
    productId: input.productId,
    origin: "generated",
    role: "generated",
    filename: `${sku}-AI-${input.variant}.jpg`,
    maxBytes: GENERATED_IMAGE_MAX_BYTES,
    blob: input.blob,
    sortOrder: variantIndex,
    appProperties: { tahaMediaId: identity.mediaId, tahaProductId: input.productId, tahaSku: sku, tahaKind: "generated", tahaVariant: input.variant },
    details: { generation: {
      variant: input.variant,
      sourceMediaId: input.source.id,
      sourceExternalId: input.source.external_id,
      sourceVersion: sourceVersion(input.source),
      sourceFingerprint: input.sourceFingerprint,
      promptVersion: input.promptVersion,
      compressionPolicy: IMAGE_COMPRESSION_POLICY,
      ...(input.model ? { model: input.model } : {}),
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
    } },
  });
}

export async function normalizeProductSourceImages(productId: string, selectedMediaIds?: readonly string[]) {
  const context = await driveContext(productId);
  const fingerprint = await productFingerprint(context.sources.product);
  const result = { productId, checked: 0, alreadyWithinLimit: 0, reused: 0, created: 0, mediaIds: [] as string[] };
  const requested = selectedMediaIds ? new Set(selectedMediaIds) : null;
  const selected = requested ? context.sources.images.filter((source) => requested.has(source.id)) : context.sources.images;
  if (requested && (requested.size !== selected.length || selected.length < 1)) throw new Error("PRODUCT_MEDIA_MISMATCH");
  for (const source of selected) {
    const index = context.sources.images.findIndex((candidate) => candidate.id === source.id);
    result.checked += 1;
    const verified = await verifyOriginalMedia(source.id);
    if (verified.size < ORIGINAL_IMAGE_MAX_BYTES) {
      const updated = await database().prepare(`UPDATE media_assets SET byte_size=?, mime_type=?, updated_at=?
        WHERE id=? AND workspace_id=? AND origin='source' AND storage_provider='google_drive'
          AND external_id=? AND source_connection_id=?
          AND COALESCE(json_extract(metadata_json,'$.md5Checksum'), json_extract(metadata_json,'$.modifiedTime'))=?
        RETURNING id`).bind(verified.size, verified.mimeType, Date.now(), source.id, TAHA_WORKSPACE_ID,
          source.external_id, context.connectionId, sourceVersion(source)).first<{ id: string }>();
      if (updated?.id !== source.id) throw new Error("PRODUCT_MEDIA_MISMATCH");
      result.alreadyWithinLimit += 1;
      result.mediaIds.push(source.id);
      continue;
    }
    const version = sourceVersion(source);
    const identityKey = [productId, source.id, source.external_id, version, IMAGE_COMPRESSION_POLICY].join(":");
    const mediaId = await stableId("media", `optimized:${identityKey}`);
    const input: PersistInput = {
      productId,
      mediaId,
      linkId: await stableId("pm", `optimized:${identityKey}`),
      origin: "derived",
      role: "source",
      filename: `${context.sources.sku}-OPT-${String(index + 1).padStart(2, "0")}.jpg`,
      maxBytes: ORIGINAL_IMAGE_MAX_BYTES,
      sortOrder: 100 + index,
      appProperties: { tahaMediaId: mediaId, tahaProductId: productId, tahaSku: context.sources.sku, tahaKind: "optimized" },
      details: { optimization: {
        policy: IMAGE_COMPRESSION_POLICY,
        sourceMediaId: source.id,
        sourceExternalId: source.external_id,
        sourceVersion: version,
        sourceFingerprint: fingerprint,
      } },
    };
    const existing = await findOrPersist(input, context);
    if (existing) {
      result.reused += 1;
      result.mediaIds.push(source.id);
      continue;
    }
    const loaded = await originalMediaBlob(source.id, 25 * 1024 * 1024);
    const compressed = await compressImageToJpeg(loaded.blob, ORIGINAL_IMAGE_MAX_BYTES);
    const saved = await findOrPersist({ ...input, blob: compressed.blob }, context);
    if (!saved) throw new Error("PRODUCT_DRIVE_MEDIA_WRITE_FAILED");
    result.created += 1;
    result.mediaIds.push(source.id);
  }
  return result;
}
