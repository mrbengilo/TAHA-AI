import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { harness, ROOT, WORKSPACE } from "./sqlite-harness.mjs";

test("saving a Facebook day materializes every ready product and leaves an explicit slot when stock is short", async () => {
  const h = harness();
  h.seedProduct("product-1", "PH0001");
  h.seedProduct("product-2", "PH0002");
  h.overrides.set(path.join(ROOT, "lib/integrations/facebook-permissions.ts"), {
    verifyFacebookConnection: async () => ({ ready: true }),
  });
  const now = Date.UTC(2099, 0, 9, 22, 0);
  await h.load("lib/facebook-publishing-plans.ts").saveFacebookPublishingPlan({
    date: "2099-01-10",
    postCount: 3,
    times: ["08:00", "12:00", "18:00"],
  }, now);

  const preparation = await h.load("lib/daily-automation.ts").materializeFacebookPublishingPlan("2099-01-10", now);
  assert.equal(preparation.queued, 2);
  assert.equal(preparation.complete, false);
  assert.equal(preparation.reason, "no_ready_product");

  const entries = await h.load("lib/publishing-history.ts").listPublishingCalendar(now);
  assert.equal(entries.length, 3);
  assert.equal(entries.filter((entry) => entry.productId).length, 2);
  assert.equal(entries.filter((entry) => entry.status === "awaiting_assignment").length, 1);
  assert.deepEqual(Array.from(entries, (entry) => entry.scheduledFor), [
    Date.UTC(2099, 0, 10, 1, 0),
    Date.UTC(2099, 0, 10, 5, 0),
    Date.UTC(2099, 0, 10, 11, 0),
  ]);
});

test("an 18-post admin day is materialized as 18 distinct products in one bounded save flow", async () => {
  const h = harness();
  for (let index = 1; index <= 18; index += 1) {
    const suffix = String(index).padStart(2, "0");
    h.seedProduct(`product-${suffix}`, `PH00${suffix}`);
  }
  h.overrides.set(path.join(ROOT, "lib/integrations/facebook-permissions.ts"), {
    verifyFacebookConnection: async () => ({ ready: true }),
  });
  const now = Date.UTC(2099, 0, 9, 22, 0);
  const times = Array.from({ length: 18 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);
  await h.load("lib/facebook-publishing-plans.ts").saveFacebookPublishingPlan({
    date: "2099-01-11",
    postCount: 18,
    times,
  }, now);

  const result = await h.load("lib/daily-automation.ts").materializeFacebookPublishingPlan("2099-01-11", now);
  assert.equal(result.complete, true);
  assert.equal(result.queued, 18);
  const runs = h.sqlite.prepare("SELECT product_id,request_key FROM automation_runs ORDER BY request_key").all();
  assert.equal(runs.length, 18);
  assert.equal(new Set(runs.map((run) => run.product_id)).size, 18);
  assert.equal(new Set(runs.map((run) => run.request_key)).size, 18);
});

test("activity history returns every persisted job for each output channel instead of five recent rows", async () => {
  const h = harness();
  h.seedProduct("product-1", "PH0001");
  h.sqlite.prepare(`INSERT INTO channel_connections
    (id,workspace_id,provider,role,display_name,status,publish_mode,created_at,updated_at)
    VALUES ('website-1',?,'website','publisher','TAHA Shoes','connected','api',1,1)`).run(WORKSPACE);
  const insert = h.sqlite.prepare(`INSERT INTO publish_jobs
    (id,workspace_id,connection_id,product_id,job_kind,dedupe_key,status,scheduled_for,available_at,
     payload_snapshot_json,attempt_count,max_attempts,external_url,completed_at,created_at,updated_at)
    VALUES (?,?, 'website-1','product-1','listing_upsert',?,'published',?,?, '{}',1,5,?,?,?,?)`);
  for (let index = 0; index < 7; index += 1) {
    const timestamp = Date.UTC(2026, 8, 9, index, 0);
    insert.run(`website-job-${index}`, WORKSPACE, `website:${index}`, timestamp, timestamp,
      `https://tahashoes.vn/ph0001-${index}`, timestamp, timestamp, timestamp);
  }

  const entries = await h.load("lib/publishing-history.ts").listPublishingActivity();
  const website = entries.filter((entry) => entry.provider === "website");
  assert.equal(website.length, 7);
  assert.ok(website.every((entry) => entry.sku === "PH0001" && entry.status === "published"));
  assert.equal(website[0].externalUrl, "https://tahashoes.vn/ph0001-6");
});
