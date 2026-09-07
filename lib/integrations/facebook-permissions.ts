import { decryptCredentials } from "./crypto";
import { getRuntimeEnv, requireEnv } from "./env";
import { TAHA_WORKSPACE_ID } from "./store";

export const FACEBOOK_REQUIRED_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
] as const;

const FACEBOOK_CREATE_CONTENT_TASKS = new Set(["CREATE_CONTENT", "PROFILE_PLUS_CREATE_CONTENT"]);
const FACEBOOK_PERMISSION_TIMEOUT_MS = 20_000;

export type FacebookPermissionCode =
  | "FACEBOOK_APP_MISMATCH"
  | "FACEBOOK_CONNECTION_CHANGED"
  | "FACEBOOK_CREATE_CONTENT_MISSING"
  | "FACEBOOK_PAGE_MISMATCH"
  | "FACEBOOK_VERIFICATION_UNAVAILABLE"
  | "FACEBOOK_REAUTH_REQUIRED"
  | "FACEBOOK_SCOPES_MISSING"
  | "FACEBOOK_TOKEN_INVALID"
  | "FACEBOOK_TOKEN_TYPE_INVALID";

export type FacebookConnectionVerificationResult = {
  ready: boolean;
  code?: FacebookPermissionCode;
  message?: string;
  missingScopes?: string[];
};

export type FacebookPermissionInspection = FacebookConnectionVerificationResult & {
  grantedScopes: string[];
};

type FacebookConnectionRow = {
  id: string;
  external_account_id: string | null;
  status: string;
  config_json: string;
  auth_ciphertext: string | null;
  auth_iv: string | null;
};

type DebugTokenData = {
  app_id?: unknown;
  granular_scopes?: unknown;
  is_valid?: unknown;
  profile_id?: unknown;
  scopes?: unknown;
  type?: unknown;
};

export class FacebookPermissionCheckError extends Error {
  constructor(
    public readonly code: FacebookPermissionCode,
    public readonly userMessage: string,
    public readonly status = 502,
  ) {
    super(code);
    this.name = "FacebookPermissionCheckError";
  }
}

function database() {
  const value = getRuntimeEnv().DB;
  if (!value) throw new Error("DATABASE_UNAVAILABLE");
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= 100))];
}

function safeConfig(value: unknown) {
  if (typeof value !== "string") return {};
  try { return asObject(JSON.parse(value)); } catch { return {}; }
}

function missingScopesMessage(missingScopes: string[]) {
  return `Facebook chưa cấp quyền ${missingScopes.join(", ")} cho Trang này. Hãy cập nhật Login Configuration rồi kết nối lại Facebook.`;
}

function failedInspection(
  code: Exclude<FacebookPermissionCode, "FACEBOOK_CONNECTION_CHANGED" | "FACEBOOK_VERIFICATION_UNAVAILABLE" | "FACEBOOK_REAUTH_REQUIRED">,
  message: string,
  grantedScopes: string[],
  missingScopes: string[] = [],
): FacebookPermissionInspection {
  return {
    ready: false,
    code,
    message,
    ...(missingScopes.length ? { missingScopes } : {}),
    grantedScopes,
  };
}

function publicResult(inspection: FacebookPermissionInspection): FacebookConnectionVerificationResult {
  return {
    ready: inspection.ready,
    ...(inspection.code ? { code: inspection.code } : {}),
    ...(inspection.message ? { message: inspection.message } : {}),
    ...(inspection.missingScopes?.length ? { missingScopes: inspection.missingScopes } : {}),
  };
}

function permissionVerification(inspection: FacebookPermissionInspection, verifiedAt: number) {
  return {
    version: 1,
    ready: inspection.ready,
    verifiedAt,
    ...(inspection.code ? { code: inspection.code } : {}),
    ...(inspection.missingScopes?.length ? { missingScopes: inspection.missingScopes } : {}),
  };
}

export async function inspectFacebookPageToken(input: {
  pageId: string;
  pageToken: string;
  tasks: string[];
}, fetcher: typeof fetch = fetch): Promise<FacebookPermissionInspection> {
  const version = requireEnv("META_GRAPH_API_VERSION");
  const appId = requireEnv("META_APP_ID");
  const appSecret = requireEnv("META_APP_SECRET");
  const url = new URL(`https://graph.facebook.com/${version}/debug_token`);
  url.searchParams.set("input_token", input.pageToken);

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { authorization: `Bearer ${appId}|${appSecret}` },
      redirect: "manual",
      signal: AbortSignal.timeout(FACEBOOK_PERMISSION_TIMEOUT_MS),
    });
  } catch {
    throw new FacebookPermissionCheckError(
      "FACEBOOK_VERIFICATION_UNAVAILABLE",
      "Facebook chưa thể kiểm tra quyền lúc này. Kết nối hiện tại chưa bị thay đổi; hãy thử lại.",
    );
  }
  if (!response.ok) {
    throw new FacebookPermissionCheckError(
      "FACEBOOK_VERIFICATION_UNAVAILABLE",
      "Facebook chưa thể kiểm tra quyền lúc này. Kết nối hiện tại chưa bị thay đổi; hãy thử lại.",
      response.status === 429 || response.status >= 500 ? 503 : 502,
    );
  }

  let root: Record<string, unknown>;
  try { root = asObject(await response.json()); } catch {
    throw new FacebookPermissionCheckError(
      "FACEBOOK_VERIFICATION_UNAVAILABLE",
      "Facebook trả về kết quả kiểm tra quyền không hợp lệ. Kết nối hiện tại chưa bị thay đổi; hãy thử lại.",
    );
  }
  const data = asObject(root.data) as DebugTokenData;
  if (Object.keys(data).length === 0) {
    throw new FacebookPermissionCheckError(
      "FACEBOOK_VERIFICATION_UNAVAILABLE",
      "Facebook trả về kết quả kiểm tra quyền không hợp lệ. Kết nối hiện tại chưa bị thay đổi; hãy thử lại.",
    );
  }

  const grantedScopes = stringList(data.scopes);
  if (data.is_valid !== true) {
    return failedInspection(
      "FACEBOOK_TOKEN_INVALID",
      "Phiên kết nối Facebook không còn hợp lệ. Hãy kết nối lại Facebook.",
      grantedScopes,
    );
  }
  if (String(data.app_id ?? "") !== appId) {
    return failedInspection(
      "FACEBOOK_APP_MISMATCH",
      "Mã truy cập Facebook không thuộc ứng dụng Meta đang cấu hình. Hãy kết nối lại Facebook.",
      grantedScopes,
    );
  }
  if (String(data.type ?? "").toUpperCase() !== "PAGE") {
    return failedInspection(
      "FACEBOOK_TOKEN_TYPE_INVALID",
      "Facebook chưa cấp mã truy cập Trang hợp lệ. Hãy kết nối lại Facebook.",
      grantedScopes,
    );
  }
  if (String(data.profile_id ?? "") !== input.pageId) {
    return failedInspection(
      "FACEBOOK_PAGE_MISMATCH",
      "Mã truy cập Facebook không thuộc đúng Trang đã kết nối. Hãy kết nối lại Facebook.",
      grantedScopes,
    );
  }

  const granularScopes = Array.isArray(data.granular_scopes)
    ? data.granular_scopes.map(asObject)
    : [];
  const missingScopes = FACEBOOK_REQUIRED_SCOPES.filter((required) => {
    if (!grantedScopes.includes(required)) return true;
    const granular = granularScopes.filter((item) => item.scope === required && Array.isArray(item.target_ids));
    return granular.length > 0
      && !granular.some((item) => (item.target_ids as unknown[]).some((target) => String(target) === input.pageId));
  });
  if (missingScopes.length) {
    return failedInspection(
      "FACEBOOK_SCOPES_MISSING",
      missingScopesMessage(missingScopes),
      grantedScopes,
      missingScopes,
    );
  }

  if (!input.tasks.some((task) => FACEBOOK_CREATE_CONTENT_TASKS.has(task))) {
    return failedInspection(
      "FACEBOOK_CREATE_CONTENT_MISSING",
      "Tài khoản Facebook chưa có quyền tạo nội dung trên Trang này. Hãy cấp quyền Trang rồi kết nối lại Facebook.",
      grantedScopes,
    );
  }

  return { ready: true, grantedScopes };
}

export async function persistFacebookPermissionState(input: {
  connectionId: string;
  expectedCiphertext: string;
  expectedIv: string;
  inspection: FacebookPermissionInspection;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const result = await database().prepare(
    `UPDATE channel_connections SET status = ?, scopes_json = ?,
     config_json = json_set(CASE WHEN json_valid(config_json) THEN config_json ELSE '{}' END,
       '$.facebookPermissionVerification', json(?)),
     last_verified_at = ?, updated_at = ?, last_error = ?
     WHERE id = ? AND workspace_id = ? AND provider = 'facebook'
       AND status IN ('connected', 'error', 'expired') AND auth_ciphertext = ? AND auth_iv = ?`,
  ).bind(
    input.inspection.ready ? "connected" : "error",
    JSON.stringify(input.inspection.grantedScopes),
    JSON.stringify(permissionVerification(input.inspection, now)),
    now,
    now,
    input.inspection.ready ? null : input.inspection.message ?? "Kết nối Facebook cần được kiểm tra lại.",
    input.connectionId,
    TAHA_WORKSPACE_ID,
    input.expectedCiphertext,
    input.expectedIv,
  ).run();
  return result.success && result.meta.changes === 1;
}

export async function verifyFacebookConnection(connectionId: string): Promise<FacebookConnectionVerificationResult> {
  const row = await database().prepare(
    `SELECT id, external_account_id, status, config_json, auth_ciphertext, auth_iv
     FROM channel_connections WHERE id = ? AND workspace_id = ? AND provider = 'facebook'
       AND status IN ('connected', 'error', 'expired') LIMIT 1`,
  ).bind(connectionId, TAHA_WORKSPACE_ID).first<FacebookConnectionRow>();
  if (!row) {
    throw new FacebookPermissionCheckError(
      "FACEBOOK_REAUTH_REQUIRED",
      "Không tìm thấy kết nối Facebook cần kiểm tra. Hãy kết nối lại Facebook.",
      404,
    );
  }
  const pageId = typeof row.external_account_id === "string" ? row.external_account_id : "";
  const ciphertext = typeof row.auth_ciphertext === "string" ? row.auth_ciphertext : "";
  const iv = typeof row.auth_iv === "string" ? row.auth_iv : "";
  if (!pageId || !ciphertext || !iv) {
    return {
      ready: false,
      code: "FACEBOOK_REAUTH_REQUIRED",
      message: "Kết nối Facebook thiếu thông tin xác thực. Hãy kết nối lại Facebook.",
    };
  }

  let pageToken = "";
  try {
    const credentials = await decryptCredentials<{ accessToken?: unknown }>(ciphertext, iv);
    pageToken = typeof credentials.accessToken === "string" ? credentials.accessToken : "";
  } catch {
    // A corrupt credential cannot be repaired by a remote permission check.
  }
  if (!pageToken) {
    const inspection: FacebookPermissionInspection = {
      ready: false,
      code: "FACEBOOK_REAUTH_REQUIRED",
      message: "Kết nối Facebook thiếu thông tin xác thực. Hãy kết nối lại Facebook.",
      grantedScopes: [],
    };
    const applied = await persistFacebookPermissionState({
      connectionId: row.id,
      expectedCiphertext: ciphertext,
      expectedIv: iv,
      inspection,
    });
    return applied ? publicResult(inspection) : {
      ready: false,
      code: "FACEBOOK_CONNECTION_CHANGED",
      message: "Kết nối Facebook đã thay đổi trong lúc kiểm tra. Hãy tải lại trạng thái kết nối.",
    };
  }

  const currentConfig = safeConfig(row.config_json);
  const tasks = stringList(currentConfig.tasks);
  let inspection: FacebookPermissionInspection;
  try {
    inspection = await inspectFacebookPageToken({ pageId, pageToken, tasks });
  } catch (error) {
    if (error instanceof FacebookPermissionCheckError) {
      return { ready: false, code: error.code, message: error.userMessage };
    }
    throw error;
  }
  const applied = await persistFacebookPermissionState({
    connectionId: row.id,
    expectedCiphertext: ciphertext,
    expectedIv: iv,
    inspection,
  });
  if (!applied) {
    return {
      ready: false,
      code: "FACEBOOK_CONNECTION_CHANGED",
      message: "Kết nối Facebook đã thay đổi trong lúc kiểm tra. Hãy tải lại trạng thái kết nối.",
    };
  }
  return publicResult(inspection);
}
