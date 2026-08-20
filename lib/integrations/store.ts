import { getRuntimeEnv } from "./env";
import { sha256Hex, verifySignedState, type OAuthStatePayload } from "./crypto";
import type { ProviderId } from "./providers";

export const TAHA_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

type ConnectionInput = {
  provider: ProviderId;
  role: "source" | "publisher" | "commerce" | "both";
  displayName: string;
  externalAccountId: string | null;
  publishMode: "api" | "assisted" | "export_only";
  scopes: string[];
  capabilities: string[];
  config?: Record<string, unknown>;
  authCiphertext?: string | null;
  authIv?: string | null;
  authKeyVersion?: number | null;
  tokenExpiresAt?: number | null;
  status?: "pending" | "connected" | "expired" | "revoked" | "error" | "disabled";
};

function db() {
  const database = getRuntimeEnv().DB;
  if (!database) throw new Error("DATABASE_UNAVAILABLE");
  return database;
}

export async function ensureWorkspace() {
  const now = Date.now();
  await db().prepare(
    `INSERT INTO workspaces (id, name, slug, timezone, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
  ).bind(TAHA_WORKSPACE_ID, "TAHA Store", "taha-store", "Asia/Ho_Chi_Minh", now, now).run();
}

export async function saveOAuthState(payload: OAuthStatePayload) {
  await ensureWorkspace();
  await db().prepare(
    `INSERT INTO oauth_states (id, workspace_id, provider, nonce_hash, return_to, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    TAHA_WORKSPACE_ID,
    payload.provider,
    await sha256Hex(payload.nonce),
    payload.returnTo,
    payload.exp,
    Date.now(),
  ).run();
}

export async function consumeOAuthState(token: string, expectedProvider: ProviderId) {
  const payload = await verifySignedState(token);
  if (payload.provider !== expectedProvider) throw new Error("OAUTH_PROVIDER_MISMATCH");
  const result = await db().prepare(
    `UPDATE oauth_states
     SET consumed_at = ?
     WHERE nonce_hash = ? AND provider = ? AND consumed_at IS NULL AND expires_at > ?
     RETURNING return_to`,
  ).bind(Date.now(), await sha256Hex(payload.nonce), expectedProvider, Date.now()).first<{ return_to: string }>();
  if (!result) throw new Error("OAUTH_STATE_REPLAYED");
  return { ...payload, returnTo: result.return_to };
}

export async function upsertConnection(input: ConnectionInput) {
  await ensureWorkspace();
  const database = db();
  const existing = input.externalAccountId
    ? await database.prepare(
        `SELECT id FROM channel_connections
         WHERE workspace_id = ? AND provider = ? AND external_account_id = ? LIMIT 1`,
      ).bind(TAHA_WORKSPACE_ID, input.provider, input.externalAccountId).first<{ id: string }>()
    : await database.prepare(
        `SELECT id FROM channel_connections
         WHERE workspace_id = ? AND provider = ? ORDER BY created_at ASC LIMIT 1`,
      ).bind(TAHA_WORKSPACE_ID, input.provider).first<{ id: string }>();

  const id = existing?.id ?? crypto.randomUUID();
  const now = Date.now();
  const values = [
    input.role,
    input.displayName,
    input.externalAccountId,
    input.status ?? "connected",
    input.publishMode,
    JSON.stringify(input.scopes),
    JSON.stringify(input.capabilities),
    JSON.stringify(input.config ?? {}),
    input.authCiphertext ?? null,
    input.authIv ?? null,
    input.authKeyVersion ?? null,
    input.tokenExpiresAt ?? null,
    now,
    now,
    null,
    id,
  ];

  if (existing) {
    await database.prepare(
      `UPDATE channel_connections SET
       role = ?, display_name = ?, external_account_id = ?, status = ?, publish_mode = ?,
       scopes_json = ?, capabilities_json = ?, config_json = ?, auth_ciphertext = ?, auth_iv = ?,
       auth_key_version = ?, token_expires_at = ?, last_verified_at = ?, updated_at = ?, last_error = ?
       WHERE id = ?`,
    ).bind(...values).run();
  } else {
    await database.prepare(
      `INSERT INTO channel_connections
       (role, display_name, external_account_id, status, publish_mode, scopes_json, capabilities_json,
        config_json, auth_ciphertext, auth_iv, auth_key_version, token_expires_at, last_verified_at,
        updated_at, last_error, id, workspace_id, provider, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(...values, TAHA_WORKSPACE_ID, input.provider, now).run();
  }
  return id;
}

export type ConnectionSummary = {
  id: string;
  provider: ProviderId;
  displayName: string;
  externalAccountId: string | null;
  status: string;
  publishMode: string;
  tokenExpiresAt: number | null;
  lastVerifiedAt: number | null;
  lastSyncedAt: number | null;
  lastError: string | null;
};

export async function listConnections(): Promise<ConnectionSummary[]> {
  const database = getRuntimeEnv().DB;
  if (!database) return [];
  try {
    const result = await database.prepare(
      `SELECT id, provider, display_name, external_account_id, status, publish_mode,
              token_expires_at, last_verified_at, last_synced_at, last_error
       FROM channel_connections WHERE workspace_id = ? ORDER BY created_at ASC`,
    ).bind(TAHA_WORKSPACE_ID).all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => ({
      id: String(row.id),
      provider: row.provider as ProviderId,
      displayName: String(row.display_name),
      externalAccountId: row.external_account_id ? String(row.external_account_id) : null,
      status: String(row.status),
      publishMode: String(row.publish_mode),
      tokenExpiresAt: typeof row.token_expires_at === "number" ? row.token_expires_at : null,
      lastVerifiedAt: typeof row.last_verified_at === "number" ? row.last_verified_at : null,
      lastSyncedAt: typeof row.last_synced_at === "number" ? row.last_synced_at : null,
      lastError: row.last_error ? String(row.last_error) : null,
    }));
  } catch {
    return [];
  }
}
