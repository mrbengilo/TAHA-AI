import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ResumeError,
  TRIAL,
  TRIAL_SELECT_SQL,
  assertRequeueResult,
  assertNoPublishedMatch,
  buildRequeueSql,
  captionForPayload,
  encodePublicReceipt,
  operationForRow,
  validateIndependentFacebookState,
  validateTrialRow,
} from "../deploy/vps/facebook-trial-resume.mjs";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE publish_jobs (id TEXT PRIMARY KEY, workspace_id TEXT, schedule_id TEXT, connection_id TEXT,
      product_id TEXT, draft_id TEXT, job_kind TEXT, dedupe_key TEXT, status TEXT, scheduled_for INTEGER,
      available_at INTEGER, payload_snapshot_json TEXT, provider_response_json TEXT, attempt_count INTEGER,
      max_attempts INTEGER, external_post_id TEXT, external_url TEXT, error_code TEXT, lease_owner TEXT,
      lease_expires_at INTEGER, started_at INTEGER, completed_at INTEGER, updated_at INTEGER);
    CREATE TABLE schedules (id TEXT PRIMARY KEY, workspace_id TEXT, draft_id TEXT, connection_id TEXT, status TEXT, created_by TEXT);
    CREATE TABLE automation_runs (id TEXT PRIMARY KEY, workspace_id TEXT, product_id TEXT, status TEXT, request_key TEXT);
    CREATE TABLE products (id TEXT PRIMARY KEY, workspace_id TEXT, base_sku TEXT);
    CREATE TABLE content_drafts (id TEXT PRIMARY KEY, workspace_id TEXT, product_id TEXT, status TEXT, target_provider TEXT,
      version INTEGER, title TEXT, body TEXT, hashtags_json TEXT);
    CREATE TABLE content_draft_media (draft_id TEXT, workspace_id TEXT, media_id TEXT, sort_order INTEGER, created_at INTEGER);
    CREATE TABLE channel_connections (id TEXT PRIMARY KEY, workspace_id TEXT, provider TEXT, status TEXT, publish_mode TEXT,
      external_account_id TEXT, config_json TEXT, auth_ciphertext TEXT, auth_iv TEXT);
  `);
  const scheduleId = "schedule-trial";
  const draftId = "draft-trial";
  const connectionId = "facebook-trial";
  const scheduledFor = 2_000;
  const payload = {
    draftVersion: 1, productId: TRIAL.productId, draftId, scheduleId, provider: "facebook",
    contentType: "social_post", title: "PH0014", message: "Bài PH0014", hashtags: ["PH0014"],
    mediaIds: ["media-1", "media-2", "media-3", "media-4"], occurrenceAt: scheduledFor,
    platformData: { sourceFingerprint: "fingerprint" },
  };
  db.prepare("INSERT INTO schedules VALUES (?,?,?,?,?,?)").run(scheduleId, TRIAL.workspaceId, draftId, connectionId, "completed", `automation:${TRIAL.runId}`);
  db.prepare("INSERT INTO automation_runs VALUES (?,?,?,?,?)").run(TRIAL.runId, TRIAL.workspaceId, TRIAL.productId, "completed", TRIAL.requestKey);
  db.prepare("INSERT INTO products VALUES (?,?,?)").run(TRIAL.productId, TRIAL.workspaceId, TRIAL.sku);
  db.prepare("INSERT INTO content_drafts VALUES (?,?,?,?,?,?,?,?,?)").run(draftId, TRIAL.workspaceId, TRIAL.productId, "approved", "facebook", 1, "PH0014", "Bài PH0014", JSON.stringify(["PH0014"]));
  db.prepare("INSERT INTO channel_connections VALUES (?,?,?,?,?,?,?,?,?)").run(connectionId, TRIAL.workspaceId, "facebook", "connected", "api", TRIAL.pageId, JSON.stringify({ tasks: ["CREATE_CONTENT"] }), "ciphertext", "iv");
  for (const [index, mediaId] of payload.mediaIds.entries()) {
    db.prepare("INSERT INTO content_draft_media VALUES (?,?,?,?,?)").run(draftId, TRIAL.workspaceId, mediaId, index, index);
  }
  db.prepare(`INSERT INTO publish_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    TRIAL.jobId, TRIAL.workspaceId, scheduleId, connectionId, TRIAL.productId, draftId, "social_post",
    `schedule:${scheduleId}:${scheduledFor}`, "failed", scheduledFor, scheduledFor, JSON.stringify(payload), "{}",
    1, 5, null, null, "FACEBOOK_API_403", null, null, 1_500, 1_900, 2_100,
  );
  return { db, row: db.prepare(TRIAL_SELECT_SQL).get() };
}

test("eligible trial CAS requeues the exact failed job once and preserves payload/checkpoints/attempts", () => {
  const { db, row } = fixture();
  validateTrialRow(row);
  assert.equal(operationForRow(row, false), "eligible");
  const first = db.prepare(buildRequeueSql(row, 3_000)).all();
  assert.equal(first.length, 1);
  const saved = db.prepare("SELECT * FROM publish_jobs").get();
  assert.equal(saved.status, "retry_wait");
  assert.equal(saved.attempt_count, 1);
  assert.equal(saved.payload_snapshot_json, row.payload_snapshot_json);
  assert.equal(saved.provider_response_json, row.provider_response_json);
  assert.equal(db.prepare(buildRequeueSql(row, 4_000)).all().length, 0);
});

test("real Wrangler D1 treats one UPDATE RETURNING row as the affected-row proof when meta.changes is absent", () => {
  const directory = mkdtempSync(join(tmpdir(), "taha-wrangler-returning-"));
  const config = join(directory, "wrangler.jsonc");
  writeFileSync(config, JSON.stringify({
    name: "d1-returning-regression",
    compatibility_date: "2026-09-01",
    d1_databases: [{ binding: "DB", database_name: "returning-test", database_id: "00000000-0000-0000-0000-000000000099" }],
  }));
  try {
    const sql = `CREATE TABLE jobs(id TEXT PRIMARY KEY,status TEXT,attempt_count INTEGER);
      INSERT INTO jobs VALUES('${TRIAL.jobId}','failed',1);
      UPDATE jobs SET status='retry_wait' WHERE id='${TRIAL.jobId}' AND status='failed' RETURNING id,status,attempt_count;
      SELECT id,status,attempt_count FROM jobs;`;
    const raw = execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local",
      `--persist-to=${join(directory, "data")}`, `--config=${config}`, "--json", "--command", sql], {
      cwd: new URL("..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    const statements = JSON.parse(raw);
    const update = statements[2];
    assert.equal(update.meta.changes, undefined);
    assert.doesNotThrow(() => assertRequeueResult(update, { attempt_count: 1 }));
    assert.deepEqual(statements[3].results, [{ id: TRIAL.jobId, status: "retry_wait", attempt_count: 1 }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("replays already requeued, publishing, or published jobs without making them eligible again", () => {
  const { db, row } = fixture();
  for (const status of ["retry_wait", "publishing"]) {
    db.prepare("UPDATE publish_jobs SET status=?").run(status);
    assert.equal(operationForRow(db.prepare(TRIAL_SELECT_SQL).get(), true), "wait");
  }
  db.prepare("UPDATE publish_jobs SET status='published', external_post_id='page_post'").run();
  assert.equal(operationForRow(db.prepare(TRIAL_SELECT_SQL).get(), true), "published");
  assert.throws(() => operationForRow(row, true), (error) => error instanceof ResumeError && error.code === "TRIAL_REQUEUE_ALREADY_USED");
});

test("CAS loses safely when admin rejects or edits the failed draft concurrently", () => {
  for (const mutation of ["UPDATE content_drafts SET status='rejected'", "UPDATE content_drafts SET version=2"]) {
    const { db, row } = fixture();
    db.exec(mutation);
    assert.equal(db.prepare(buildRequeueSql(row, 3_000)).all().length, 0);
    assert.equal(db.prepare("SELECT status FROM publish_jobs").get().status, "failed");
  }
});

test("wrong SKU, changed draft payload, and unknown delivery outcomes fail closed", () => {
  const { db, row } = fixture();
  db.prepare("UPDATE products SET base_sku='PH9999'").run();
  assert.throws(() => validateTrialRow(db.prepare(TRIAL_SELECT_SQL).get()), /TRIAL_IDENTITY_MISMATCH/);
  db.prepare("UPDATE products SET base_sku=?").run(TRIAL.sku);
  db.prepare("UPDATE content_drafts SET version=2").run();
  assert.equal(db.prepare(buildRequeueSql(row, 3_000)).all().length, 0);
  db.prepare("UPDATE publish_jobs SET status='blocked', error_code='FACEBOOK_DELIVERY_OUTCOME_UNKNOWN'").run();
  assert.throws(() => operationForRow(db.prepare(TRIAL_SELECT_SQL).get(), false), /TRIAL_NOT_ELIGIBLE/);
});

test("independent Meta checks reject missing grants and mismatched Pages", () => {
  const ready = {
    pageId: TRIAL.pageId, appId: "app", tasks: ["CREATE_CONTENT"], identity: { id: TRIAL.pageId }, page: { id: TRIAL.pageId },
    debugData: { is_valid: true, app_id: "app", type: "PAGE", profile_id: TRIAL.pageId,
      scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"], granular_scopes: [] },
  };
  assert.doesNotThrow(() => validateIndependentFacebookState(ready));
  assert.throws(() => validateIndependentFacebookState({ ...ready, debugData: { ...ready.debugData, scopes: ["pages_show_list"] } }), /FACEBOOK_SCOPES_MISSING/);
  assert.throws(() => validateIndependentFacebookState({ ...ready, identity: { id: "other" } }), /FACEBOOK_PAGE_MISMATCH/);
  assert.throws(() => validateIndependentFacebookState({ ...ready, appId: "other-app" }), /FACEBOOK_TOKEN_INVALID/);
});

test("published-post scan fails closed on Graph errors, matches, and incomplete pagination", async () => {
  const base = { version: "v99.0", pageId: TRIAL.pageId, pageToken: "secret", since: 1, until: 2,
    caption: captionForPayload({ message: "Bài PH0014", hashtags: ["PH0014"] }), sku: TRIAL.sku };
  await assert.rejects(assertNoPublishedMatch({ ...base, fetcher: async () => new Response("{}", { status: 500 }) }), /FACEBOOK_POST_LOOKUP_FAILED/);
  await assert.rejects(assertNoPublishedMatch({ ...base, fetcher: async () => Response.json({ data: [{ id: "post", message: "Bài PH0014" }] }) }), /FACEBOOK_TRIAL_POST_ALREADY_EXISTS/);
  await assert.rejects(assertNoPublishedMatch({ ...base, fetcher: async () => Response.json({ data: [], paging: { next: "unsafe" } }) }), /FACEBOOK_POST_LOOKUP_INCOMPLETE/);
  await assert.doesNotReject(assertNoPublishedMatch({ ...base, fetcher: async () => Response.json({ data: [] }) }));
});

test("machine-readable receipt encoding contains only verified public receipt fields", () => {
  const receipt = { runId: TRIAL.runId, jobId: TRIAL.jobId, sku: TRIAL.sku,
    postId: `${TRIAL.pageId}_123`, url: `https://www.facebook.com/${TRIAL.pageId}_123`, accessToken: "never-encode" };
  const decoded = JSON.parse(Buffer.from(encodePublicReceipt(receipt), "base64url").toString("utf8"));
  assert.deepEqual(decoded, {
    runId: receipt.runId, jobId: receipt.jobId, sku: receipt.sku, postId: receipt.postId, url: receipt.url,
  });
  assert.equal("accessToken" in decoded, false);
});
