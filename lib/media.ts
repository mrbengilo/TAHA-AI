import { getRuntimeEnv } from "./integrations/env";
import { getConnectedIntegration, getGoogleAccessToken } from "./integrations/connection-secrets";
import { TAHA_WORKSPACE_ID } from "./integrations/store";

type MediaRow = {
  id: string;
  storage_provider: "google_drive" | "r2" | "external";
  external_id: string | null;
  storage_key: string | null;
  mime_type: string | null;
  byte_size: number | null;
  metadata_json: string;
  source_connection_id: string | null;
};

export type LoadedMedia = {
  body: ReadableStream<Uint8Array> | ArrayBuffer;
  mimeType: string;
  filename: string;
  size: number | null;
};

async function mediaRow(mediaId: string) {
  const database = getRuntimeEnv().DB;
  if (!database) throw new Error("DATABASE_UNAVAILABLE");
  const row = await database.prepare(
    `SELECT id, storage_provider, external_id, storage_key, mime_type, byte_size, metadata_json, source_connection_id
     FROM media_assets WHERE id = ? AND workspace_id = ? AND status = 'ready' LIMIT 1`,
  ).bind(mediaId, TAHA_WORKSPACE_ID).first<MediaRow>();
  if (!row) throw new Error("MEDIA_NOT_FOUND");
  return row;
}

export async function loadMedia(mediaId: string): Promise<LoadedMedia> {
  const row = await mediaRow(mediaId);
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
    if (!row.external_id) throw new Error("MEDIA_OBJECT_MISSING");
    if (!row.source_connection_id) throw new Error("MEDIA_SOURCE_CONNECTION_MISSING");
    const connection = await getConnectedIntegration<{ accessToken?: unknown; refreshToken?: unknown }>("google", row.source_connection_id);
    const token = await getGoogleAccessToken(connection);
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(row.external_id)}`);
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok || !response.body) throw new Error("GOOGLE_MEDIA_FETCH_FAILED");
    return {
      body: response.body,
      mimeType: response.headers.get("content-type") || row.mime_type || "application/octet-stream",
      filename,
      size: Number(response.headers.get("content-length")) || row.byte_size,
    };
  }

  throw new Error("EXTERNAL_MEDIA_DISABLED");
}

export async function mediaBlob(mediaId: string, maxBytes = 10 * 1024 * 1024) {
  const media = await loadMedia(mediaId);
  if (media.size && media.size > maxBytes) throw new Error("MEDIA_TOO_LARGE");
  const response = new Response(media.body, { headers: { "content-type": media.mimeType } });
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) throw new Error("MEDIA_TOO_LARGE");
  return { ...media, blob: new Blob([buffer], { type: media.mimeType }) };
}
