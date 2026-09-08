import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { harness, ROOT, WORKSPACE } from "./sqlite-harness.mjs";

test("daily Google refresh succeeds once per Vietnam day and throttles failures", async () => {
  const h = harness();
  let syncs = 0;
  h.overrides.get(path.join(ROOT, "lib/integrations/google-sync.ts")).syncGoogleCatalog = async () => ({ products: ++syncs });
  const daily = h.load("lib/daily-automation.ts");
  const morning = Date.UTC(2026, 8, 8, 0, 0);
  const first = await daily.ensureDailyGoogleCatalogRefresh(morning);
  assert.equal(first.refreshed, true);
  assert.equal(first.day, "2026-09-08");
  assert.equal((await daily.ensureDailyGoogleCatalogRefresh(morning + 60_000)).reason, "already_refreshed");
  assert.equal(syncs, 1);

  h.sqlite.prepare(`UPDATE channel_connections SET config_json = json_remove(config_json,
    '$._dailyCatalogRefreshSucceededDay', '$._dailyCatalogRefreshAttemptDay', '$._dailyCatalogRefreshAttemptAt') WHERE id='google-1'`).run();
  h.overrides.get(path.join(ROOT, "lib/integrations/google-sync.ts")).syncGoogleCatalog = async () => { syncs += 1; throw new Error("GOOGLE_TEMPORARY_FAILURE"); };
  await assert.rejects(daily.ensureDailyGoogleCatalogRefresh(morning + 2 * 60_000), /GOOGLE_TEMPORARY_FAILURE/);
  assert.equal((await daily.ensureDailyGoogleCatalogRefresh(morning + 3 * 60_000)).reason, "retry_deferred");
  assert.equal(syncs, 2);
  await assert.rejects(daily.ensureDailyGoogleCatalogRefresh(morning + 62 * 60_000), /GOOGLE_TEMPORARY_FAILURE/);
  assert.equal(syncs, 3);
});

test("daily rotation queues only Facebook with original Drive images", async () => {
  const h = harness(); h.seedProduct();
  h.overrides.set(path.join(ROOT, "lib/integrations/facebook-permissions.ts"), {
    verifyFacebookConnection: async () => ({ ready: true }),
  });
  h.sqlite.prepare("UPDATE channel_connections SET config_json=json_set(config_json,'$.dailyAutomationEnabled',1) WHERE id='facebook-1'").run();
  h.sqlite.prepare(`INSERT INTO channel_connections
    (id,workspace_id,provider,role,display_name,status,publish_mode,config_json,created_at,updated_at)
    VALUES ('website-1',?,'website','publish','Website','connected','api','{"dailyAutomationEnabled":true}',1,1)`).run(WORKSPACE);
  const daily = h.load("lib/daily-automation.ts");
  const planned = await daily.ensureDailyProductAutomation(Date.UTC(2026, 8, 7, 22, 0)); // 05:00 in Vietnam.
  assert.equal(planned.queued, true, JSON.stringify(planned));
  const run = h.sqlite.prepare("SELECT request_key,requested_image_count,target_providers_json,content_json FROM automation_runs").get();
  assert.equal(run.request_key, "daily:2026-09-08:0800:product-1");
  assert.equal(JSON.parse(run.content_json).scheduledFor, undefined);
  assert.equal(run.requested_image_count, 0);
  assert.deepEqual(JSON.parse(run.target_providers_json), ["facebook"]);
  assert.deepEqual(JSON.parse(run.content_json).targetConnections, { facebook: "facebook-1" });
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS total FROM automation_steps WHERE step_type='image'").get().total, 0);
});

test("daily rotation does not duplicate an existing 08:00 Facebook schedule", async () => {
  const h = harness(); h.seedProduct();
  h.sqlite.prepare("UPDATE channel_connections SET config_json=json_set(config_json,'$.dailyAutomationEnabled',1) WHERE id='facebook-1'").run();
  const runAt = Date.UTC(2026, 8, 8, 1, 0); // 08:00 in Vietnam.
  h.sqlite.prepare(`INSERT INTO content_drafts
    (id,workspace_id,product_id,target_provider,content_type,language,body,hashtags_json,platform_data_json,status,version,generator,prompt_version,generation_meta_json,created_at,updated_at)
    VALUES ('existing-facebook-draft',?,'product-1','facebook','social_post','vi','Scheduled','[]','{}','approved',1,'openai','source-only-v1','{}',1,1)`).run(WORKSPACE);
  h.sqlite.prepare(`INSERT INTO schedules
    (id,workspace_id,draft_id,connection_id,status,schedule_kind,run_at,weekdays_json,timezone,next_run_at,execution_mode,publish_options_json,created_at,updated_at)
    VALUES ('existing-facebook-schedule',?,'existing-facebook-draft','facebook-1','active','once',?,'[]','Asia/Ho_Chi_Minh',?,'auto','{}',1,1)`).run(WORKSPACE, runAt, runAt);
  const outcome = await h.load("lib/daily-automation.ts").ensureDailyProductAutomation(Date.UTC(2026, 8, 7, 22, 0));
  assert.equal(outcome.queued, false);
  assert.equal(outcome.reason, "already_scheduled");
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS total FROM automation_runs").get().total, 0);
});

test("Google catalog sync does not cap original Drive photos", () => {
  const source = readFileSync(path.join(ROOT, "lib/integrations/google-sync.ts"), "utf8");
  assert.doesNotMatch(source, /MAX_PRODUCT_SOURCE_IMAGES/);
  assert.doesNotMatch(source, /files\.slice\(0,/);
  assert.match(source, /for \(const \[index, file\] of files\.entries\(\)\)/);
});
