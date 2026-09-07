import { getRuntimeEnv } from "./integrations/env";
import { getConnectedIntegration, getGoogleAccessToken } from "./integrations/connection-secrets";
import { TAHA_WORKSPACE_ID } from "./integrations/store";
import { IMAGE_COMPRESSION_POLICY, ORIGINAL_IMAGE_MAX_BYTES } from "./image-compression";

type MediaRow = {
  id: string;
  storage_provider: "google_drive" | "r2" | "external";
  external_id: string | null;
  storage_key: string | null;
  mime_type: string | null;
  byte_size: number | null;
  metadata_json: string;
  source_connection_id: string | null;
  origin: "source" | "uploaded" | "generated" | "derived";
};

export type LoadedMedia = {
  body: ReadableStream<Uint8Array> | ArrayBuffer;
  mimeType: string;
  filename: string;
  size: number | null;
};

async function fetchDriveMedia(url: URL, token: string, timeout: number) {
  let response: Response;
  try { response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeout) }); }
  catch { throw new Error("GOOGLE_MEDIA_UNAVAILABLE"); }
  if (!response.ok) throw new Error(response.status === 429 || response.status >= 500 ? "GOOGLE_MEDIA_TEMPORARY_FAILURE" : "GOOGLE_MEDIA_FETCH_FAILED");
  return response;
}

async function mediaRow(mediaId: string) {
  const database = getRuntimeEnv().DB;
  if (!database) throw new Error("DATABASE_UNAVAILABLE");
  const row = await database.prepare(
    `SELECT id, storage_provider, external_id, storage_key, mime_type, byte_size, metadata_json, source_connection_id, origin
     FROM media_assets WHERE id = ? AND workspace_id = ? AND status = 'ready' LIMIT 1`,
  ).bind(mediaId, TAHA_WORKSPACE_ID).first<MediaRow>();
  if (!row) throw new Error("MEDIA_NOT_FOUND");
  return row;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function optimizedRow(source: MediaRow) {
  if (source.origin !== "source" || !source.external_id) return null;
  const database = getRuntimeEnv().DB;
  if (!database) throw new Error("DATABASE_UNAVAILABLE");
  const sourceMetadata = record(JSON.parse(source.metadata_json || "{}"));
  const driveSource = record(sourceMetadata.googleDriveSource);
  const sourceVersion = String(sourceMetadata.md5Checksum || sourceMetadata.modifiedTime || "");
  if (!sourceVersion) return null;
  const result = await database.prepare(
    `SELECT id, storage_provider, external_id, storage_key, mime_type, byte_size, metadata_json, source_connection_id, origin
     FROM media_assets WHERE workspace_id = ? AND origin = 'derived' AND storage_provider = 'google_drive'
       AND status = 'ready' AND byte_size > 0 AND byte_size < ?
       AND json_extract(metadata_json, '$.optimization.policy') = ?
       AND json_extract(metadata_json, '$.optimization.sourceMediaId') = ?
       AND json_extract(metadata_json, '$.optimization.sourceExternalId') = ?
       AND json_extract(metadata_json, '$.optimization.sourceVersion') = ?
     ORDER BY id LIMIT 2`,
  ).bind(TAHA_WORKSPACE_ID, ORIGINAL_IMAGE_MAX_BYTES, IMAGE_COMPRESSION_POLICY, source.id, source.external_id, sourceVersion).all<MediaRow>();
  const rows = result.results ?? [];
  if (rows.length > 1) throw new Error("OPTIMIZED_MEDIA_AMBIGUOUS");
  const candidate = rows[0];
  if (!candidate) return null;
  const candidateSource = record(record(JSON.parse(candidate.metadata_json || "{}")).googleDriveSource);
  if (candidate.source_connection_id !== source.source_connection_id
    || candidate.mime_type !== "image/jpeg"
    || candidateSource.connectionId !== driveSource.connectionId
    || candidateSource.driveFolderId !== driveSource.driveFolderId
    || candidateSource.skuKey !== driveSource.skuKey) throw new Error("OPTIMIZED_MEDIA_MISMATCH");
  return candidate;
}

async function verifiedDriveRequest(row: MediaRow, metadata: Record<string, unknown>) {
  if (!row.external_id) throw new Error("MEDIA_OBJECT_MISSING");
  if (!row.source_connection_id) throw new Error("MEDIA_SOURCE_CONNECTION_MISSING");
  const connection = await getConnectedIntegration<{ accessToken?: unknown; refreshToken?: unknown }>("google", row.source_connection_id);
  const token = await getGoogleAccessToken(connection);
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(row.external_id)}`);
  const source = metadata.googleDriveSource as { driveFolderId?: string } | undefined;
  let file: { parents?: string[]; trashed?: boolean; mimeType?: string; size?: string; modifiedTime?: string; md5Checksum?: string } | null = null;
  if (source?.driveFolderId) {
    url.searchParams.set("fields", "id,parents,trashed,mimeType,size,modifiedTime,md5Checksum");
    url.searchParams.set("supportsAllDrives", "true");
    const checked = await fetchDriveMedia(url, token, 30_000);
    file = await checked.json() as { parents?: string[]; trashed?: boolean; mimeType?: string; size?: string; modifiedTime?: string; md5Checksum?: string };
    const expectedVersion = String(metadata.md5Checksum || metadata.modifiedTime || "");
    const actualVersion = String(file.md5Checksum || file.modifiedTime || "");
    if (file.trashed || !file.parents?.includes(source.driveFolderId) || !file.mimeType?.startsWith("image/")
      || !expectedVersion || actualVersion !== expectedVersion) throw new Error("PRODUCT_MEDIA_MISMATCH");
  }
  url.search = "";
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  return { url, token, file };
}

async function loadRow(row: MediaRow): Promise<LoadedMedia> {
  const metadata = JSON.parse(row.metadata_json || "{}") as Record<string, unknown>;
  const filename = typeof metadata.name === "string" ? metadata.name : `${row.id}.jpg`;

  if (row.storage_provider === "r2") {
    if (!row.storage_key || !getRuntimeEnv().MEDIA) throw new Error("MEDIA_OBJECT_MISSING");
    const object = await getRuntimeEnv().MEDIA!.get(row.storage_key);
    if (!object) throw new Error("MEDIA_OBJECT_MISSING");
    return {
      body: object.body,
      mimeType: object.httpMetadata?.contentType || row.mime_type || "application/octet-stream",
      filename,
      size: object.size,
    };
  }

  if (row.storage_provider === "google_drive") {
    const { url, token } = await verifiedDriveRequest(row, metadata);
    const response = await fetchDriveMedia(url, token, 60_000);
    if (!response.body) throw new Error("GOOGLE_MEDIA_FETCH_FAILED");
    return {
      body: response.body,
      mimeType: response.headers.get("content-type") || row.mime_type || "application/octet-stream",
      filename,
      size: Number(response.headers.get("content-length")) || row.byte_size,
    };
  }

  throw new Error("EXTERNAL_MEDIA_DISABLED");
}

export async function loadMedia(mediaId: string): Promise<LoadedMedia> {
  const source = await mediaRow(mediaId);
  const optimized = await optimizedRow(source);
  if (optimized) await verifiedDriveRequest(source, JSON.parse(source.metadata_json || "{}") as Record<string, unknown>);
  return loadRow(optimized ?? source);
}

export async function loadOriginalMedia(mediaId: string): Promise<LoadedMedia> {
  return loadRow(await mediaRow(mediaId));
}

export async function verifyOriginalMedia(mediaId: string) {
  const row = await mediaRow(mediaId);
  if (row.origin !== "source" || row.storage_provider !== "google_drive") throw new Error("PRODUCT_MEDIA_MISMATCH");
  const metadata = JSON.parse(row.metadata_json || "{}") as Record<string, unknown>;
  const { file } = await verifiedDriveRequest(row, metadata);
  const size = Number(file?.size);
  if (!file?.mimeType?.startsWith("image/") || !Number.isFinite(size) || size < 1) throw new Error("PRODUCT_MEDIA_MISMATCH");
  return { size, mimeType: file.mimeType };
}

export async function mediaBlob(mediaId: string, maxBytes = 10 * 1024 * 1024) {
  const media = await loadMedia(mediaId);
  if (media.size && media.size > maxBytes) throw new Error("MEDIA_TOO_LARGE");
  const response = new Response(media.body, { headers: { "content-type": media.mimeType } });
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) throw new Error("MEDIA_TOO_LARGE");
  return { ...media, blob: new Blob([buffer], { type: media.mimeType }) };
}

export async function originalMediaBlob(mediaId: string, maxBytes = 10 * 1024 * 1024) {
  const media = await loadOriginalMedia(mediaId);
  if (media.size && media.size > maxBytes) throw new Error("MEDIA_TOO_LARGE");
  const buffer = await new Response(media.body, { headers: { "content-type": media.mimeType } }).arrayBuffer();
  if (buffer.byteLength > maxBytes) throw new Error("MEDIA_TOO_LARGE");
  return { ...media, blob: new Blob([buffer], { type: media.mimeType }) };
}
