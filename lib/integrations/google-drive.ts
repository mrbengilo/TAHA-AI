import { getRuntimeEnv } from "./env";
import { TAHA_WORKSPACE_ID } from "./store";

export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_DRIVE_FULL_SCOPE = "https://www.googleapis.com/auth/drive";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const MULTIPART_UPLOAD_LIMIT = 5 * 1024 * 1024;
const DRIVE_REQUEST_TIMEOUT_MS = 60_000;

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  parents?: string[];
  trashed?: boolean;
  appProperties?: Record<string, string>;
};

export type IndexedDriveFile = DriveFile & {
  sourceFolderId: string;
  matchKind: "sku_folder" | "filename";
};

export type DriveSkuAssets = {
  skuKey: string;
  targetFolderId: string | null;
  targetFolderName: string | null;
  targetKind: "sku_folder" | "root" | "none";
  files: IndexedDriveFile[];
};

export type DriveAssetIndex = {
  bySku: Map<string, DriveSkuAssets>;
  rootFiles: number;
  matchedRootFiles: number;
  matchedSkuFolders: number;
  unmatchedRootImages: number;
};

export class GoogleDriveError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
    public readonly status = 502,
    public readonly details?: unknown,
  ) {
    super(code);
    this.name = "GoogleDriveError";
  }
}

function database() {
  const value = getRuntimeEnv().DB;
  if (!value) throw new Error("DATABASE_UNAVAILABLE");
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function parseScopes(value: unknown) {
  if (Array.isArray(value)) return value.filter((scope): scope is string => typeof scope === "string");
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((scope): scope is string => typeof scope === "string") : [];
  } catch {
    return [];
  }
}

export function normalizeSkuKey(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^SKU\s+/i, "")
    .toUpperCase();
}

export function canonicalGoogleDriveSkuFolderName(value: unknown) {
  const skuKey = normalizeSkuKey(value);
  return skuKey ? `SKU ${skuKey}` : "";
}

function isWordCharacter(value: string | undefined) {
  return Boolean(value && /[\p{L}\p{N}]/u.test(value));
}

function hasSkuBoundaryMatch(value: string, skuKey: string) {
  let offset = value.indexOf(skuKey);
  while (offset >= 0) {
    const before = offset > 0 ? value[offset - 1] : undefined;
    const afterOffset = offset + skuKey.length;
    const after = afterOffset < value.length ? value[afterOffset] : undefined;
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    offset = value.indexOf(skuKey, offset + 1);
  }
  return false;
}

export function matchSkuFromFilename(filename: string, skuKeys: Iterable<string>) {
  const stem = filename.replace(/\.[^.]+$/, "");
  const normalizedStem = normalizeSkuKey(stem);
  const matches = [...skuKeys]
    .map(normalizeSkuKey)
    .filter((skuKey) => skuKey && hasSkuBoundaryMatch(normalizedStem, skuKey))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  if (!matches.length) return null;
  if (matches.length > 1 && matches[0].length === matches[1].length && matches[0] !== matches[1]) return null;
  return matches[0];
}

function escapeDriveQuery(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function sortDriveFiles(files: DriveFile[]) {
  return [...files].sort((left, right) => left.name.localeCompare(right.name, "en", { numeric: true, sensitivity: "base" }) || left.id.localeCompare(right.id));
}

async function responseErrorDetails(response: Response) {
  try {
    const payload = asRecord(await response.json());
    const error = asRecord(payload.error);
    const reasons = Array.isArray(error.errors)
      ? error.errors.map((item) => asRecord(item).reason).filter((reason): reason is string => typeof reason === "string")
      : [];
    return {
      message: typeof error.message === "string" ? error.message : null,
      reasons,
    };
  } catch {
    return { message: null, reasons: [] as string[] };
  }
}

async function driveFetch(url: URL | string, init: RequestInit, operation: "read" | "write") {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(DRIVE_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleDriveError("GOOGLE_DRIVE_UNAVAILABLE", "Không thể kết nối Google Drive lúc này.", 503);
  }
  if (response.ok) return response;

  const details = await responseErrorDetails(response);
  if (response.status === 401) {
    throw new GoogleDriveError("GOOGLE_REAUTH_REQUIRED", "Google yêu cầu kết nối lại tài khoản.", 401, details);
  }
  if (response.status === 403) {
    const insufficientScope = details.reasons.some((reason) => reason === "insufficientPermissions" || reason === "insufficientAuthenticationScopes");
    if (operation === "write" && insufficientScope) {
      throw new GoogleDriveError("GOOGLE_WRITE_SCOPE_REQUIRED", "Hãy kết nối lại Google và cấp quyền tạo tệp trong Drive.", 409, details);
    }
    if (operation === "write" && details.reasons.includes("insufficientFilePermissions")) {
      throw new GoogleDriveError("GOOGLE_DRIVE_FOLDER_NOT_WRITABLE", "Tài khoản Google không có quyền chỉnh sửa thư mục SKU này.", 403, details);
    }
    throw new GoogleDriveError("GOOGLE_DRIVE_FORBIDDEN", "Google Drive từ chối thao tác này.", 403, details);
  }
  if (response.status === 404) {
    throw new GoogleDriveError("GOOGLE_DRIVE_RESOURCE_NOT_FOUND", "Không tìm thấy tệp hoặc thư mục Google Drive.", 404, details);
  }
  if (response.status === 429 || response.status >= 500) {
    throw new GoogleDriveError("GOOGLE_DRIVE_TEMPORARY_FAILURE", "Google Drive đang bận, hãy thử lại sau.", 503, details);
  }
  throw new GoogleDriveError("GOOGLE_DRIVE_REQUEST_FAILED", "Google Drive không thể xử lý yêu cầu.", 502, details);
}

async function driveJson<T>(url: URL | string, token: string, operation: "read" | "write", init: RequestInit = {}) {
  const response = await driveFetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  }, operation);
  return response.json() as Promise<T>;
}

export async function listGoogleDriveChildren(folderId: string, token: string) {
  const files: DriveFile[] = [];
  let pageToken = "";
  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", `'${escapeDriveQuery(folderId)}' in parents and trashed = false`);
    url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum,parents,trashed,appProperties)");
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("orderBy", "name_natural");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await driveJson<{ files?: DriveFile[]; nextPageToken?: string }>(url, token, "read");
    files.push(...(data.files ?? []));
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return sortDriveFiles(files);
}

async function mapInBatches<T, U>(values: T[], batchSize: number, mapper: (value: T) => Promise<U>) {
  const result: U[] = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    result.push(...await Promise.all(values.slice(offset, offset + batchSize).map(mapper)));
  }
  return result;
}

export async function indexGoogleDriveAssets(rootFolderId: string, skuValues: Iterable<string>, token: string): Promise<DriveAssetIndex> {
  const skuKeys = [...new Set([...skuValues].map(normalizeSkuKey).filter(Boolean))].sort();
  const skuSet = new Set(skuKeys);
  const bySku = new Map(skuKeys.map((skuKey): [string, DriveSkuAssets] => [skuKey, {
    skuKey,
    targetFolderId: null,
    targetFolderName: null,
    targetKind: "none",
    files: [],
  }]));
  const rootChildren = await listGoogleDriveChildren(rootFolderId, token);
  const foldersBySku = new Map<string, DriveFile[]>();
  for (const file of rootChildren) {
    if (file.mimeType !== FOLDER_MIME_TYPE) continue;
    const skuKey = normalizeSkuKey(file.name);
    if (!skuSet.has(skuKey)) continue;
    foldersBySku.set(skuKey, [...(foldersBySku.get(skuKey) ?? []), file]);
  }

  const duplicateFolders = [...foldersBySku.entries()]
    .filter(([, folders]) => folders.length > 1)
    .map(([skuKey, folders]) => ({ skuKey, folders: folders.map((folder) => ({ id: folder.id, name: folder.name })) }));
  if (duplicateFolders.length) {
    throw new GoogleDriveError(
      "GOOGLE_DUPLICATE_SKU_FOLDERS",
      "Google Drive có nhiều thư mục trùng SKU; hãy giữ lại đúng một thư mục cho mỗi SKU.",
      409,
      duplicateFolders,
    );
  }

  const rootImages = rootChildren.filter((file) => file.mimeType.startsWith("image/") && !file.appProperties?.tahaMediaId);
  let matchedRootFiles = 0;
  for (const file of rootImages) {
    const skuKey = matchSkuFromFilename(file.name, skuKeys);
    if (!skuKey) continue;
    const bucket = bySku.get(skuKey);
    if (!bucket) continue;
    bucket.targetFolderId = rootFolderId;
    bucket.targetKind = "root";
    bucket.files.push({ ...file, sourceFolderId: rootFolderId, matchKind: "filename" });
    matchedRootFiles += 1;
  }

  const folderEntries = [...foldersBySku.entries()].map(([skuKey, folders]) => ({ skuKey, folder: folders[0] }));
  const folderResults = await mapInBatches(folderEntries, 5, async ({ skuKey, folder }) => ({
    skuKey,
    folder,
    files: (await listGoogleDriveChildren(folder.id, token)).filter((file) => file.mimeType.startsWith("image/") && !file.appProperties?.tahaMediaId),
  }));
  for (const { skuKey, folder, files } of folderResults) {
    const bucket = bySku.get(skuKey);
    if (!bucket) continue;
    bucket.targetFolderId = folder.id;
    bucket.targetFolderName = folder.name;
    bucket.targetKind = "sku_folder";
    bucket.files.push(...files.map((file): IndexedDriveFile => ({ ...file, sourceFolderId: folder.id, matchKind: "sku_folder" })));
  }
  for (const bucket of bySku.values()) {
    const uniqueFiles = new Map(bucket.files.map((file) => [file.id, file]));
    bucket.files = [...uniqueFiles.values()].sort((left, right) => {
      const sourcePriority = (left.matchKind === "sku_folder" ? 0 : 1) - (right.matchKind === "sku_folder" ? 0 : 1);
      return sourcePriority || left.name.localeCompare(right.name, "en", { numeric: true, sensitivity: "base" }) || left.id.localeCompare(right.id);
    });
  }

  return {
    bySku,
    rootFiles: rootImages.length,
    matchedRootFiles,
    matchedSkuFolders: folderResults.length,
    unmatchedRootImages: rootImages.length - matchedRootFiles,
  };
}

export async function markGoogleConnectionReauthRequired(connectionId: string, reason: string) {
  const now = Date.now();
  await database().prepare(
    `UPDATE channel_connections SET status = 'expired', last_error = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND provider = 'google'`,
  ).bind(reason, now, connectionId, TAHA_WORKSPACE_ID).run();
}

export async function requireGoogleDriveWriteScope(connectionId: string) {
  const row = await database().prepare(
    `SELECT scopes_json FROM channel_connections
     WHERE id = ? AND workspace_id = ? AND provider = 'google' LIMIT 1`,
  ).bind(connectionId, TAHA_WORKSPACE_ID).first<{ scopes_json: unknown }>();
  const scopes = parseScopes(row?.scopes_json);
  if (scopes.includes(GOOGLE_DRIVE_FILE_SCOPE) || scopes.includes(GOOGLE_DRIVE_FULL_SCOPE)) return scopes;
  await markGoogleConnectionReauthRequired(connectionId, "GOOGLE_WRITE_SCOPE_REQUIRED");
  throw new GoogleDriveError("GOOGLE_WRITE_SCOPE_REQUIRED", "Hãy kết nối lại Google và cấp quyền tạo tệp trong Drive.", 409, {
    requiredScope: GOOGLE_DRIVE_FILE_SCOPE,
  });
}

export function sanitizeGoogleDriveFilename(value: string) {
  const normalized = Array.from(value.normalize("NFKC"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 || character === "/" || character === "\\" ? "-" : character;
  }).join("").trim();
  return (normalized || "TAHA-image").slice(0, 180);
}

function normalizedAppProperties(value: Record<string, string> | undefined) {
  if (!value) return undefined;
  const entries = Object.entries(value)
    .filter(([key, item]) => key && item)
    .map(([key, item]) => [key.slice(0, 100), item.slice(0, 120)] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export async function findGoogleDriveFileByAppProperty(
  token: string,
  folderId: string,
  key: string,
  value: string,
) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set(
    "q",
    `'${escapeDriveQuery(folderId)}' in parents and trashed = false and appProperties has { key='${escapeDriveQuery(key)}' and value='${escapeDriveQuery(value)}' }`,
  );
  url.searchParams.set("fields", "files(id,name,mimeType,size,modifiedTime,md5Checksum,parents,trashed,appProperties)");
  url.searchParams.set("pageSize", "2");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  const data = await driveJson<{ files?: DriveFile[] }>(url, token, "read");
  return sortDriveFiles(data.files ?? [])[0] ?? null;
}

export async function uploadGoogleDriveImage(input: {
  token: string;
  folderId: string;
  filename: string;
  mimeType: string;
  blob: Blob;
  appProperties?: Record<string, string>;
}) {
  if (!input.mimeType.startsWith("image/")) {
    throw new GoogleDriveError("GOOGLE_DRIVE_IMAGE_REQUIRED", "Chỉ có thể tải ảnh lên Google Drive.", 415);
  }
  if (input.blob.size < 1) throw new GoogleDriveError("EMPTY_FILE", "Ảnh tải lên đang trống.", 422);
  const metadata = {
    name: sanitizeGoogleDriveFilename(input.filename),
    mimeType: input.mimeType,
    parents: [input.folderId],
    appProperties: normalizedAppProperties(input.appProperties),
  };

  if (input.blob.size <= MULTIPART_UPLOAD_LIMIT) {
    const boundary = `taha_${crypto.randomUUID().replace(/-/g, "")}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`,
      input.blob,
      `\r\n--${boundary}--\r\n`,
    ]);
    const url = new URL("https://www.googleapis.com/upload/drive/v3/files");
    url.searchParams.set("uploadType", "multipart");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("fields", "id,name,mimeType,size,modifiedTime,md5Checksum,parents,trashed,appProperties");
    return driveJson<DriveFile>(url, input.token, "write", {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body,
    });
  }

  const startUrl = new URL("https://www.googleapis.com/upload/drive/v3/files");
  startUrl.searchParams.set("uploadType", "resumable");
  startUrl.searchParams.set("supportsAllDrives", "true");
  startUrl.searchParams.set("fields", "id,name,mimeType,size,modifiedTime,md5Checksum,parents,trashed,appProperties");
  const start = await driveFetch(startUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": input.mimeType,
      "x-upload-content-length": String(input.blob.size),
    },
    body: JSON.stringify(metadata),
  }, "write");
  const location = start.headers.get("location");
  if (!location) throw new GoogleDriveError("GOOGLE_DRIVE_UPLOAD_SESSION_INVALID", "Google Drive không tạo được phiên tải ảnh.", 502);
  const sessionUrl = new URL(location);
  if (sessionUrl.protocol !== "https:" || (sessionUrl.hostname !== "www.googleapis.com" && !sessionUrl.hostname.endsWith(".googleapis.com"))) {
    throw new GoogleDriveError("GOOGLE_DRIVE_UPLOAD_SESSION_INVALID", "Google Drive trả về phiên tải ảnh không hợp lệ.", 502);
  }
  return driveJson<DriveFile>(sessionUrl, input.token, "write", {
    method: "PUT",
    headers: { "content-type": input.mimeType },
    body: input.blob,
  });
}
