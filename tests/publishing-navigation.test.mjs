import assert from "node:assert/strict";
import test from "node:test";
import { harness, WORKSPACE } from "./sqlite-harness.mjs";

function navigationFixture() {
  const h = harness();
  const now = Date.now();
  h.sqlite.prepare(`INSERT INTO channel_connections
    (id,workspace_id,provider,role,display_name,status,publish_mode,created_at,updated_at)
    VALUES ('zalo-navigation',?,'zalo_personal','destination','Zalo','connected','assisted',?,?)`).run(WORKSPACE, now, now);
  const insert = h.sqlite.prepare(`INSERT INTO publish_jobs
    (id,workspace_id,connection_id,job_kind,status,scheduled_for,available_at,dedupe_key,payload_snapshot_json,created_at,updated_at)
    VALUES (?, ?, ?, 'social_post', ?, ?, ?, ?, '{}', ?, ?)`);
  for (let index = 0; index < 60; index += 1) {
    insert.run(`history-${index}`, WORKSPACE, "zalo-navigation", "published", now, now, `history-${index}`, now, now);
  }
  insert.run("old-zalo-pending", WORKSPACE, "zalo-navigation", "awaiting_confirmation", now - 86400000, now, "old-zalo-pending", now - 86400000, now - 86400000);
  insert.run("facebook-failed", WORKSPACE, "facebook-1", "failed", now - 3600000, now, "facebook-failed", now, now);
  return h;
}

test("old Zalo pending and focused history jobs remain reachable beyond fifty newer rows", async () => {
  const h = navigationFixture();
  const library = h.load("lib/channel-library.ts");
  const pending = await library.getChannelLibrary("zalo_personal", 50);
  assert.equal(pending.jobs[0].id, "old-zalo-pending");
  const focused = await library.getChannelLibrary("zalo_personal", 1, "history-59");
  assert.equal(focused.jobs[0].id, "history-59");
  const wrongChannel = await library.getChannelLibrary("zalo_personal", 50, "facebook-failed");
  assert.equal(wrongChannel.jobs.some((job) => job.id === "facebook-failed"), false);
});

test("calendar exposes actionable job IDs and failures without misclassifying them as upcoming posts", async () => {
  const h = navigationFixture();
  const snapshot = await h.load("lib/dashboard.ts").getDashboardSnapshot();
  assert.ok(snapshot.capturedAt > 0);
  assert.equal(snapshot.calendarJobs[0].id, "old-zalo-pending");
  assert.equal(snapshot.calendarJobs.find((job) => job.id === "facebook-failed").status, "failed");
  assert.equal(snapshot.upcoming.some((job) => job.id === "facebook-failed"), false);
});
