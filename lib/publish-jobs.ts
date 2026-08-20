import { sha256Hex } from "./integrations/crypto";
import { getRuntimeEnv } from "./integrations/env";
import type { ProviderId } from "./integrations/providers";
import { TAHA_WORKSPACE_ID } from "./integrations/store";

type StartInput = {
  connectionId: string;
  dedupeKey: string;
  jobKind: "social_post" | "listing_upsert" | "listing_unpublish" | "inventory_sync";
  payload: Record<string, unknown>;
  status?: "publishing" | "awaiting_confirmation";
  expectedProvider?: ProviderId;
  expectedPublishMode?: "api" | "assisted" | "export_only";
};

type ExistingJob = {
  id: string;
  connection_id: string;
  job_kind: StartInput["jobKind"];
  status: string;
  payload_snapshot_json: string;
  external_post_id: string | null;
  external_url: string | null;
};

type ConnectionRow = {
  id: string;
  provider: ProviderId;
  publish_mode: "api" | "assisted" | "export_only";
};

function database() {
  const value = getRuntimeEnv().DB;
  if (!value) throw new Error("DATABASE_UNAVAILABLE");
  return value;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

function serializePayload(payload: Record<string, unknown>) {
  return JSON.stringify(canonicalValue(payload));
}

function replayResult(existing: ExistingJob, input: StartInput, payloadSnapshot: string) {
  let storedPayload: Record<string, unknown>;
  try {
    storedPayload = JSON.parse(existing.payload_snapshot_json) as Record<string, unknown>;
  } catch {
    throw new Error("IDEMPOTENCY_KEY_IN_USE");
  }
  if (
    existing.connection_id !== input.connectionId
    || existing.job_kind !== input.jobKind
    || serializePayload(storedPayload) !== payloadSnapshot
  ) {
    throw new Error("IDEMPOTENCY_KEY_IN_USE");
  }
  return { replay: true as const, ...existing, payload: storedPayload };
}

export async function startPublishJob(input: StartInput) {
  const db = database();
  const connection = await db.prepare(
    `SELECT id, provider, publish_mode FROM channel_connections
     WHERE id = ? AND workspace_id = ? AND status = 'connected' LIMIT 1`,
  ).bind(input.connectionId, TAHA_WORKSPACE_ID).first<ConnectionRow>();
  if (
    !connection
    || (input.expectedProvider && connection.provider !== input.expectedProvider)
    || (input.expectedPublishMode && connection.publish_mode !== input.expectedPublishMode)
  ) {
    throw new Error("CONNECTION_NOT_FOUND");
  }

  const payloadSnapshot = serializePayload(input.payload);
  const scopedDedupeKey = `publish:v1:${await sha256Hex(serializePayload({
    workspaceId: TAHA_WORKSPACE_ID,
    connectionId: input.connectionId,
    jobKind: input.jobKind,
    callerKey: input.dedupeKey,
  }))}`;
  const id = crypto.randomUUID();
  const now = Date.now();
  const inserted = await db.prepare(
    `INSERT INTO publish_jobs (id, workspace_id, connection_id, job_kind, dedupe_key, status, scheduled_for,
     available_at, payload_snapshot_json, attempt_count, max_attempts, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 5, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING
     RETURNING id, connection_id, job_kind, status, payload_snapshot_json, external_post_id, external_url`,
  ).bind(
    id,
    TAHA_WORKSPACE_ID,
    input.connectionId,
    input.jobKind,
    scopedDedupeKey,
    input.status ?? "publishing",
    now,
    now,
    payloadSnapshot,
    now,
    now,
    now,
  ).first<ExistingJob>();
  if (inserted) {
    return {
      replay: false as const,
      ...inserted,
      payload: input.payload,
    };
  }

  const existing = await db.prepare(
    `SELECT id, connection_id, job_kind, status, payload_snapshot_json, external_post_id, external_url
     FROM publish_jobs WHERE workspace_id = ? AND dedupe_key = ? LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID, scopedDedupeKey).first<ExistingJob>();
  if (!existing) throw new Error("PUBLISH_JOB_DEDUPE_CONFLICT");
  return replayResult(existing, input, payloadSnapshot);
}

export async function markJobPublished(jobId: string, externalId?: string | null, externalUrl?: string | null, providerResponse: Record<string, unknown> = {}) {
  const now = Date.now();
  await database().prepare(
    `UPDATE publish_jobs SET status = 'published', external_post_id = ?, external_url = ?, provider_response_json = ?,
     completed_at = ?, updated_at = ?, error_code = NULL, error_message = NULL WHERE id = ? AND workspace_id = ?`,
  ).bind(externalId ?? null, externalUrl ?? null, JSON.stringify(providerResponse), now, now, jobId, TAHA_WORKSPACE_ID).run();
}

export async function markJobFailed(jobId: string, errorCode: string, errorMessage: string) {
  const now = Date.now();
  await database().prepare(
    `UPDATE publish_jobs SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status NOT IN ('published', 'cancelled')`,
  ).bind(errorCode, errorMessage.slice(0, 500), now, now, jobId, TAHA_WORKSPACE_ID).run();
}

export async function markJobBlocked(jobId: string, errorCode: string, errorMessage: string) {
  const now = Date.now();
  await database().prepare(
    `UPDATE publish_jobs SET status = 'blocked', error_code = ?, error_message = ?,
     lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status NOT IN ('published', 'cancelled')`,
  ).bind(errorCode, errorMessage.slice(0, 500), now, jobId, TAHA_WORKSPACE_ID).run();
}

export async function confirmAssistedJob(jobId: string, result: "published" | "failed", externalUrl: string | null, actorId: string | null) {
  const now = Date.now();
  const updated = await database().prepare(
    `UPDATE publish_jobs SET status = ?, external_url = ?, manual_action_by = ?, manual_action_at = ?,
     completed_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'awaiting_confirmation'
     RETURNING id`,
  ).bind(result, externalUrl, actorId, now, now, now, jobId, TAHA_WORKSPACE_ID).first<{ id: string }>();
  if (!updated) throw new Error("JOB_NOT_AWAITING_CONFIRMATION");
}
