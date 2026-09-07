// One-shot recovery for the single authorized PH0014 Facebook trial.
// The dispatcher remains the only component allowed to publish.
import { execFileSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const TRIAL = Object.freeze({
  workspaceId: "00000000-0000-4000-8000-000000000001",
  runId: "f2ced019-aa03-4600-973f-b0fee21c33bc",
  jobId: "6ab6e1fc-1a05-4b6f-8053-565b94bd9481",
  productId: "f71003d5-0009-42d8-8ea2-d94496fa3758",
  pageId: "1015096011692783",
  requestKey: "trial:drive-only-facebook-v2",
  sku: "PH0014",
  mediaCount: 4,
});

export const REQUIRED_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];
const CONTENT_TASKS = new Set(["CREATE_CONTENT", "PROFILE_PLUS_CREATE_CONTENT"]);
const MAX_POST_PAGES = 10;
const POSTS_PER_PAGE = 100;
const ATTEMPT_MARGIN_MS = 10 * 60_000;
const POLL_MS = 15_000;
const POLL_LIMIT = 60;
const RECOVERY_DIR = "/data/ops-recovery";
const RECOVERY_FILE = `${RECOVERY_DIR}/facebook-trial-${TRIAL.jobId}.json`;

export class ResumeError extends Error {
  constructor(code) {
    super(code);
    this.name = "ResumeError";
    this.code = code;
  }
}

function fail(code) {
  throw new ResumeError(code);
}

function safeCode(error) {
  const code = error instanceof ResumeError ? error.code : error instanceof Error ? error.message : "TRIAL_RESUME_FAILED";
  return /^[A-Z][A-Z0-9_]{2,100}$/.test(code) ? code : "TRIAL_RESUME_FAILED";
}

function parseJson(value, code) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(code);
    return parsed;
  } catch (error) {
    if (error instanceof ResumeError) throw error;
    fail(code);
  }
}

function stringArray(value, code) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) fail(code);
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function captionForPayload(payload) {
  const message = typeof payload.message === "string" ? payload.message : "";
  const hashtags = Array.isArray(payload.hashtags)
    ? payload.hashtags
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => `#${value.trim().replace(/^#+/, "")}`)
    : [];
  const caption = [message.trim(), hashtags.join(" ")].filter(Boolean).join("\n\n");
  if (!caption) fail("TRIAL_PAYLOAD_INVALID");
  return caption;
}

export function validateTrialRow(row) {
  if (!row) fail("TRIAL_JOB_NOT_FOUND");
  if (row.workspace_id !== TRIAL.workspaceId || row.run_id !== TRIAL.runId || row.job_id !== TRIAL.jobId
    || row.product_id !== TRIAL.productId || row.request_key !== TRIAL.requestKey || row.sku !== TRIAL.sku) {
    fail("TRIAL_IDENTITY_MISMATCH");
  }
  if (row.run_status !== "completed" || row.schedule_created_by !== `automation:${TRIAL.runId}`
    || row.schedule_status !== "completed" || row.schedule_draft_id !== row.draft_id
    || row.schedule_connection_id !== row.connection_id || row.draft_product_id !== TRIAL.productId
    || row.provider !== "facebook" || row.publish_mode !== "api") {
    fail("TRIAL_RELATIONSHIP_MISMATCH");
  }
  if (Number(row.trial_job_count) !== 1 || row.job_kind !== "social_post") fail("TRIAL_JOB_COUNT_MISMATCH");
  if (row.page_id !== TRIAL.pageId) fail("TRIAL_PAGE_INVALID");

  const payload = parseJson(row.payload_snapshot_json, "TRIAL_PAYLOAD_INVALID");
  const providerResponse = parseJson(row.provider_response_json, "TRIAL_CHECKPOINT_INVALID");
  const draftHashtags = JSON.parse(row.draft_hashtags_json);
  const currentMediaIds = JSON.parse(row.current_media_ids_json);
  const mediaIds = stringArray(payload.mediaIds, "TRIAL_MEDIA_SCHEMA_MISMATCH");
  if (mediaIds.length !== TRIAL.mediaCount || new Set(mediaIds).size !== mediaIds.length
    || !sameJson(mediaIds, currentMediaIds)) fail("TRIAL_MEDIA_SCHEMA_MISMATCH");
  if (payload.productId !== TRIAL.productId || payload.draftId !== row.draft_id
    || payload.scheduleId !== row.schedule_id || payload.provider !== "facebook"
    || payload.contentType !== "social_post" || Number(payload.occurrenceAt) !== Number(row.scheduled_for)) {
    fail("TRIAL_PAYLOAD_IDENTITY_MISMATCH");
  }
  if (!Number.isInteger(payload.draftVersion) || payload.draftVersion !== Number(row.draft_version)
    || row.draft_status !== "approved" || row.draft_provider !== "facebook") fail("TRIAL_DRAFT_CHANGED");
  if (payload.message !== row.draft_body || (payload.title ?? null) !== (row.draft_title ?? null)
    || !sameJson(payload.hashtags, draftHashtags)) fail("TRIAL_DRAFT_CHANGED");
  if (!payload.platformData || typeof payload.platformData !== "object"
    || typeof payload.platformData.sourceFingerprint !== "string" || !payload.platformData.sourceFingerprint) {
    fail("TRIAL_SOURCE_GUARD_MISSING");
  }
  if (row.dedupe_key !== `schedule:${row.schedule_id}:${row.scheduled_for}`) fail("TRIAL_DEDUPE_MISMATCH");
  if (!Number.isFinite(Number(row.started_at)) || Number(row.started_at) <= 0) fail("TRIAL_ATTEMPT_TIME_MISSING");
  return { payload, providerResponse, mediaIds, caption: captionForPayload(payload) };
}

export function operationForRow(row, markerExists) {
  if (row.job_status === "published") {
    if (!row.external_post_id) fail("TRIAL_PUBLISHED_RECEIPT_MISSING");
    return "published";
  }
  if (["queued", "retry_wait", "publishing"].includes(row.job_status)) {
    if (!markerExists) fail("TRIAL_UNEXPECTED_IN_FLIGHT");
    return "wait";
  }
  if (row.job_status !== "failed" || row.error_code !== "FACEBOOK_API_403"
    || row.external_post_id !== null || row.external_url !== null || row.lease_owner !== null
    || row.lease_expires_at !== null) fail("TRIAL_NOT_ELIGIBLE");
  if (!Number.isInteger(Number(row.attempt_count)) || Number(row.attempt_count) < 1
    || Number(row.attempt_count) >= Number(row.max_attempts)) fail("TRIAL_ATTEMPT_INVALID");
  if (markerExists) fail("TRIAL_REQUEUE_ALREADY_USED");
  return "eligible";
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildRequeueSql(row, now) {
  return `UPDATE publish_jobs SET status='retry_wait', available_at=${now}, completed_at=NULL, updated_at=${now}
WHERE id=${sqlText(TRIAL.jobId)} AND workspace_id=${sqlText(TRIAL.workspaceId)}
  AND status='failed' AND error_code='FACEBOOK_API_403'
  AND external_post_id IS NULL AND external_url IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL
  AND attempt_count=${Number(row.attempt_count)} AND max_attempts=${Number(row.max_attempts)}
  AND updated_at=${Number(row.job_updated_at)} AND dedupe_key=${sqlText(row.dedupe_key)}
  AND schedule_id=${sqlText(row.schedule_id)} AND connection_id=${sqlText(row.connection_id)}
  AND product_id=${sqlText(TRIAL.productId)} AND draft_id=${sqlText(row.draft_id)} AND job_kind='social_post'
  AND payload_snapshot_json=${sqlText(row.payload_snapshot_json)}
  AND provider_response_json=${sqlText(row.provider_response_json)}
  AND ${sqlText(row.current_media_ids_json)}=(SELECT json_group_array(media_id) FROM (
    SELECT media_id FROM content_draft_media WHERE draft_id=publish_jobs.draft_id AND workspace_id=publish_jobs.workspace_id
    ORDER BY sort_order,created_at))
  AND EXISTS (
    SELECT 1 FROM schedules s
    JOIN automation_runs r ON s.created_by='automation:' || r.id AND s.workspace_id=r.workspace_id
    JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id
    JOIN content_drafts d ON d.id=publish_jobs.draft_id AND d.workspace_id=publish_jobs.workspace_id
    JOIN channel_connections c ON c.id=publish_jobs.connection_id AND c.workspace_id=publish_jobs.workspace_id
    WHERE s.id=publish_jobs.schedule_id AND s.draft_id=publish_jobs.draft_id
      AND s.connection_id=publish_jobs.connection_id AND r.id=${sqlText(TRIAL.runId)} AND r.status='completed'
      AND r.request_key=${sqlText(TRIAL.requestKey)} AND p.id=${sqlText(TRIAL.productId)} AND p.base_sku=${sqlText(TRIAL.sku)}
      AND s.status='completed' AND d.product_id=${sqlText(TRIAL.productId)}
      AND d.status='approved' AND d.target_provider='facebook'
      AND d.version=json_extract(publish_jobs.payload_snapshot_json,'$.draftVersion')
      AND c.provider='facebook' AND c.external_account_id=${sqlText(TRIAL.pageId)}
      AND c.status='connected' AND c.publish_mode='api'
  )
  AND 1=(SELECT COUNT(*) FROM publish_jobs other
    JOIN schedules os ON os.id=other.schedule_id AND os.workspace_id=other.workspace_id
    WHERE os.created_by=${sqlText(`automation:${TRIAL.runId}`)})
RETURNING id,status,attempt_count`;
}

export function validateIndependentFacebookState({ pageId, appId, tasks, debugData, identity, page }) {
  if (String(identity?.id ?? "") !== pageId || String(page?.id ?? "") !== pageId) fail("FACEBOOK_PAGE_MISMATCH");
  if (debugData?.is_valid !== true || String(debugData.app_id ?? "") !== appId
    || String(debugData.type ?? "").toUpperCase() !== "PAGE" || String(debugData.profile_id ?? "") !== pageId) {
    fail("FACEBOOK_TOKEN_INVALID");
  }
  const scopes = stringArray(debugData.scopes, "FACEBOOK_SCOPES_MISSING");
  const granular = Array.isArray(debugData.granular_scopes) ? debugData.granular_scopes : [];
  for (const required of REQUIRED_SCOPES) {
    if (!scopes.includes(required)) fail("FACEBOOK_SCOPES_MISSING");
    const scoped = granular.filter((item) => item?.scope === required && Array.isArray(item.target_ids));
    if (scoped.length && !scoped.some((item) => item.target_ids.map(String).includes(pageId))) fail("FACEBOOK_SCOPES_MISSING");
  }
  if (!tasks.some((task) => CONTENT_TASKS.has(task))) fail("FACEBOOK_CREATE_CONTENT_MISSING");
}

async function graphJson(fetcher, version, path, params, bearer, code) {
  const url = new URL(`https://graph.facebook.com/${version}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  let response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { authorization: `Bearer ${bearer}` },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    fail(code);
  }
  if (!response.ok || response.status >= 300) fail(code);
  try {
    const data = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data) || data.error) fail(code);
    return data;
  } catch (error) {
    if (error instanceof ResumeError) throw error;
    fail(code);
  }
}

export async function assertNoPublishedMatch({ fetcher = fetch, version, pageId, pageToken, since, until, caption, sku }) {
  let after = null;
  for (let pageIndex = 0; pageIndex < MAX_POST_PAGES; pageIndex += 1) {
    const result = await graphJson(fetcher, version, `${pageId}/published_posts`, {
      fields: "id,permalink_url,message,created_time",
      limit: POSTS_PER_PAGE,
      since,
      until,
      ...(after ? { after } : {}),
    }, pageToken, "FACEBOOK_POST_LOOKUP_FAILED");
    if (!Array.isArray(result.data)) fail("FACEBOOK_POST_LOOKUP_INCOMPLETE");
    for (const post of result.data) {
      if (!post || typeof post !== "object" || typeof post.id !== "string") fail("FACEBOOK_POST_LOOKUP_INCOMPLETE");
      const message = typeof post.message === "string" ? post.message : "";
      if (message === caption || message.includes(sku)) fail("FACEBOOK_TRIAL_POST_ALREADY_EXISTS");
    }
    if (!result.paging?.next) return;
    const cursor = result.paging?.cursors?.after;
    if (typeof cursor !== "string" || !cursor || cursor === after) fail("FACEBOOK_POST_LOOKUP_INCOMPLETE");
    after = cursor;
  }
  fail("FACEBOOK_POST_LOOKUP_INCOMPLETE");
}

export const TRIAL_SELECT_SQL = `SELECT
  j.id AS job_id, j.workspace_id, j.schedule_id, j.connection_id, j.product_id, j.draft_id,
  j.job_kind, j.dedupe_key, j.status AS job_status, j.scheduled_for, j.available_at,
  j.payload_snapshot_json, j.provider_response_json, j.attempt_count, j.max_attempts,
  j.external_post_id, j.external_url, j.error_code, j.lease_owner, j.lease_expires_at,
  j.started_at, j.completed_at, j.updated_at AS job_updated_at,
  s.status AS schedule_status, s.created_by AS schedule_created_by,
  s.draft_id AS schedule_draft_id, s.connection_id AS schedule_connection_id,
  r.id AS run_id, r.status AS run_status, r.request_key,
  p.base_sku AS sku,
  d.product_id AS draft_product_id, d.status AS draft_status, d.target_provider AS draft_provider, d.version AS draft_version,
  d.title AS draft_title, d.body AS draft_body, d.hashtags_json AS draft_hashtags_json,
  c.external_account_id AS page_id, c.provider, c.status AS connection_status, c.publish_mode, c.config_json,
  c.auth_ciphertext, c.auth_iv,
  (SELECT json_group_array(media_id) FROM (
    SELECT media_id FROM content_draft_media WHERE draft_id=j.draft_id AND workspace_id=j.workspace_id
    ORDER BY sort_order, created_at
  )) AS current_media_ids_json,
  (SELECT COUNT(*) FROM publish_jobs trial_job
    JOIN schedules trial_schedule ON trial_schedule.id=trial_job.schedule_id AND trial_schedule.workspace_id=trial_job.workspace_id
    WHERE trial_schedule.created_by='automation:' || r.id) AS trial_job_count
FROM publish_jobs j
JOIN schedules s ON s.id=j.schedule_id AND s.workspace_id=j.workspace_id
  AND s.draft_id=j.draft_id AND s.connection_id=j.connection_id
JOIN automation_runs r ON s.created_by='automation:' || r.id AND s.workspace_id=r.workspace_id
JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id
JOIN content_drafts d ON d.id=j.draft_id AND d.workspace_id=j.workspace_id
JOIN channel_connections c ON c.id=j.connection_id AND c.workspace_id=j.workspace_id
WHERE j.id='${TRIAL.jobId}' AND j.workspace_id='${TRIAL.workspaceId}' LIMIT 2`;

function settings() {
  return Object.fromEntries(readFileSync("/app/.dev.vars", "utf8").split(/\r?\n/).flatMap((line) => {
    const index = line.indexOf("=");
    return index > 0 ? [[line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(["'])(.*)\1$/, "$2")]] : [];
  }));
}

function d1(sql) {
  let raw;
  try {
    raw = execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", "--persist-to=/data",
      "--config=/app/wrangler.vps.jsonc", "--json", "--command", sql], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 45_000,
    });
  } catch {
    fail("TRIAL_DATABASE_OPERATION_FAILED");
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed[0]?.success) fail("TRIAL_DATABASE_OPERATION_FAILED");
    return parsed[0];
  } catch (error) {
    if (error instanceof ResumeError) throw error;
    fail("TRIAL_DATABASE_OPERATION_FAILED");
  }
}

function selectTrialRow() {
  const rows = d1(TRIAL_SELECT_SQL).results ?? [];
  if (rows.length !== 1) fail(rows.length ? "TRIAL_IDENTITY_AMBIGUOUS" : "TRIAL_JOB_NOT_FOUND");
  return rows[0];
}

async function decryptPageToken(row, env) {
  try {
    const key = await webcrypto.subtle.importKey("raw", Buffer.from(env.INTEGRATION_TOKEN_ENCRYPTION_KEY, "base64url"),
      { name: "AES-GCM" }, false, ["decrypt"]);
    const decrypted = await webcrypto.subtle.decrypt({
      name: "AES-GCM",
      iv: Buffer.from(row.auth_iv, "base64url"),
      additionalData: new TextEncoder().encode("taha-ai:integration-token:v1"),
      tagLength: 128,
    }, key, Buffer.from(row.auth_ciphertext, "base64url"));
    const credentials = JSON.parse(new TextDecoder().decode(decrypted));
    if (typeof credentials.accessToken !== "string" || !credentials.accessToken) fail("FACEBOOK_TOKEN_MISSING");
    return credentials.accessToken;
  } catch (error) {
    if (error instanceof ResumeError) throw error;
    fail("FACEBOOK_TOKEN_MISSING");
  }
}

async function internalPermissionCheck(env, connectionId) {
  if (!env.INTERNAL_API_SECRET) fail("INTERNAL_API_SECRET_MISSING");
  let response;
  try {
    response = await fetch("http://127.0.0.1:8787/api/integrations/facebook/verify", {
      method: "POST",
      headers: { authorization: `Bearer ${env.INTERNAL_API_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ connectionId }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    fail("FACEBOOK_INTERNAL_VERIFY_FAILED");
  }
  let body;
  try { body = await response.json(); } catch { fail("FACEBOOK_INTERNAL_VERIFY_FAILED"); }
  if (!response.ok || body?.data?.ready !== true || body.data.code || (body.data.missingScopes?.length ?? 0) > 0) {
    fail("FACEBOOK_INTERNAL_VERIFY_FAILED");
  }
}

async function metaPreflight(row, env) {
  if (!/^v\d+\.\d+$/.test(env.META_GRAPH_API_VERSION ?? "") || !env.META_APP_ID || !env.META_APP_SECRET) {
    fail("FACEBOOK_CONFIG_INVALID");
  }
  await internalPermissionCheck(env, row.connection_id);
  const refreshed = selectTrialRow();
  const refreshedValidated = validateTrialRow(refreshed);
  if (refreshed.connection_status !== "connected" || refreshed.page_id !== row.page_id) fail("FACEBOOK_CONNECTION_CHANGED");
  const pageToken = await decryptPageToken(refreshed, env);
  const version = env.META_GRAPH_API_VERSION;
  const identity = await graphJson(fetch, version, "me", { fields: "id,name" }, pageToken, "FACEBOOK_IDENTITY_LOOKUP_FAILED");
  const page = await graphJson(fetch, version, refreshed.page_id, { fields: "id,name" }, pageToken, "FACEBOOK_PAGE_LOOKUP_FAILED");
  const debug = await graphJson(fetch, version, "debug_token", { input_token: pageToken }, `${env.META_APP_ID}|${env.META_APP_SECRET}`, "FACEBOOK_TOKEN_DEBUG_FAILED");
  const tasks = stringArray(parseJson(refreshed.config_json, "FACEBOOK_CONFIG_INVALID").tasks, "FACEBOOK_CREATE_CONTENT_MISSING");
  validateIndependentFacebookState({ pageId: refreshed.page_id, appId: env.META_APP_ID, tasks, debugData: debug.data, identity, page });
  const until = Math.floor(Date.now() / 1000) + 60;
  const since = Math.max(0, Math.floor((Number(refreshed.started_at) - ATTEMPT_MARGIN_MS) / 1000));
  await assertNoPublishedMatch({ fetcher: fetch, version, pageId: refreshed.page_id, pageToken, since, until,
    caption: refreshedValidated.caption, sku: TRIAL.sku });
  return refreshed;
}

function markerRecord(row, state) {
  return {
    version: 1,
    state,
    recordedAt: Date.now(),
    workspaceId: row.workspace_id,
    runId: row.run_id,
    jobId: row.job_id,
    productId: row.product_id,
    requestKey: row.request_key,
    sku: row.sku,
    jobSnapshot: {
      status: row.job_status,
      errorCode: row.error_code,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      dedupeKey: row.dedupe_key,
      payloadSha256: createHash("sha256").update(row.payload_snapshot_json).digest("hex"),
      providerResponse: row.provider_response_json,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      updatedAt: row.job_updated_at,
    },
  };
}

function createMarker(row) {
  mkdirSync(RECOVERY_DIR, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(RECOVERY_FILE, `${JSON.stringify(markerRecord(row, "prepared"))}\n`, { flag: "wx", mode: 0o600 });
    syncPath(RECOVERY_FILE);
    syncPath(RECOVERY_DIR);
  } catch {
    fail("TRIAL_REQUEUE_ALREADY_USED");
  }
}

function finishMarker(row) {
  const temporary = `${RECOVERY_FILE}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(markerRecord(row, "requeued"))}\n`, { flag: "wx", mode: 0o600 });
  syncPath(temporary);
  renameSync(temporary, RECOVERY_FILE);
  syncPath(RECOVERY_DIR);
}

function syncPath(path) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function markerExists() {
  try { readFileSync(RECOVERY_FILE, "utf8"); return true; } catch { return false; }
}

function requeue(row) {
  createMarker(row);
  const now = Date.now();
  const result = d1(buildRequeueSql(row, now));
  if ((result.results ?? []).length !== 1 || Number(result.meta?.changes ?? 0) !== 1) fail("TRIAL_REQUEUE_CAS_FAILED");
  finishMarker(row);
  console.log(`TRIAL_RESUME_REQUEUED=${JSON.stringify({ jobId: TRIAL.jobId, attemptCount: row.attempt_count })}`);
}

async function verifiedReceipt(row) {
  const validated = validateTrialRow(row);
  if (!/^[A-Za-z0-9_-]+$/.test(row.external_post_id ?? "")) fail("TRIAL_PUBLISHED_RECEIPT_INVALID");
  const env = settings();
  if (!/^v\d+\.\d+$/.test(env.META_GRAPH_API_VERSION ?? "")) fail("FACEBOOK_CONFIG_INVALID");
  const token = await decryptPageToken(row, env);
  const post = await graphJson(fetch, env.META_GRAPH_API_VERSION, row.external_post_id,
    { fields: "id,permalink_url,message,created_time" }, token, "FACEBOOK_RECEIPT_VERIFY_FAILED");
  const message = typeof post.message === "string" ? post.message : "";
  let permalink;
  let createdAt;
  try {
    permalink = new URL(post.permalink_url);
    createdAt = Date.parse(post.created_time);
  } catch {
    fail("FACEBOOK_RECEIPT_VERIFY_FAILED");
  }
  if (post.id !== row.external_post_id || (message !== validated.caption && !message.includes(TRIAL.sku))
    || permalink.protocol !== "https:" || !/(^|\.)facebook\.com$/.test(permalink.hostname)
    || !Number.isFinite(createdAt) || createdAt < Number(row.started_at) - ATTEMPT_MARGIN_MS) {
    fail("FACEBOOK_RECEIPT_VERIFY_FAILED");
  }
  return { runId: TRIAL.runId, jobId: TRIAL.jobId, sku: TRIAL.sku, postId: post.id, url: permalink.toString() };
}

async function waitForReceipt() {
  let previous = "";
  for (let index = 0; index < POLL_LIMIT; index += 1) {
    const row = selectTrialRow();
    const state = JSON.stringify({ status: row.job_status, errorCode: row.error_code ?? null, attemptCount: row.attempt_count });
    if (state !== previous) {
      console.log(`TRIAL_RESUME_STATE=${state}`);
      previous = state;
    }
    if (row.job_status === "published") {
      if (!row.external_post_id) fail("TRIAL_PUBLISHED_RECEIPT_MISSING");
      console.log(`FACEBOOK_TRIAL_RECEIPT=${JSON.stringify(await verifiedReceipt(row))}`);
      return;
    }
    if (["failed", "blocked", "cancelled", "awaiting_confirmation"].includes(row.job_status)) fail("TRIAL_RESUME_STOPPED");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  fail("TRIAL_RESUME_TIMEOUT");
}

async function main() {
  const wantsRequeue = process.argv.includes("--requeue");
  let row = selectTrialRow();
  validateTrialRow(row);
  const operation = operationForRow(row, markerExists());
  if (operation === "published") {
    console.log(`FACEBOOK_TRIAL_RECEIPT=${JSON.stringify(await verifiedReceipt(row))}`);
    return;
  }
  if (operation === "wait") {
    console.log(`TRIAL_RESUME_REPLAY=${JSON.stringify({ jobId: TRIAL.jobId, status: row.job_status })}`);
    if (wantsRequeue) await waitForReceipt();
    return;
  }
  const env = settings();
  row = await metaPreflight(row, env);
  if (!wantsRequeue) {
    console.log(`TRIAL_RESUME_PREFLIGHT=${JSON.stringify({ eligible: true, runId: TRIAL.runId, jobId: TRIAL.jobId, sku: TRIAL.sku })}`);
    return;
  }
  if (operationForRow(row, markerExists()) !== "eligible") fail("TRIAL_NOT_ELIGIBLE");
  requeue(row);
  await waitForReceipt();
}

if (process.argv[1] === "-" && process.argv.includes("--run")) {
  main().catch((error) => {
    console.error(`TRIAL_RESUME_FAILED=${safeCode(error)}`);
    process.exitCode = 1;
  });
}
