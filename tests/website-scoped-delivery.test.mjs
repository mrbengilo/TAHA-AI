import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { harness, WORKSPACE, ROOT } from "./sqlite-harness.mjs";

const RUN = "52e8a5a1-ce4d-4ef7-9f90-c1fa1af35222";
const NOW = 1_800_000_000_000;

function seed() {
  const h = harness();
  h.seedProduct();
  for (const [id, provider] of [["website-1", "website"], ["tiktok-1", "tiktok_shop"]]) {
    h.sqlite.prepare(`INSERT INTO channel_connections
      (id,workspace_id,provider,role,display_name,status,publish_mode,created_at,updated_at)
      VALUES (?,?,?,'both',?,'connected','api',?,?)`).run(id, WORKSPACE, provider, provider, NOW, NOW);
  }
  h.sqlite.prepare(`INSERT INTO automation_runs
    (id,workspace_id,product_id,source_media_id,request_key,status,requested_image_count,completed_image_count,
     target_providers_json,content_json,created_at,updated_at)
    VALUES (?,?,'product-1','image-product-1','exact-trial','completed',0,0,'["website"]',?,?,?)`)
    .run(RUN, WORKSPACE, JSON.stringify({ prepareOnly: false, targetConnections: { website: "website-1" } }), NOW, NOW);
  const addSchedule = (id, connection = "website-1", createdBy = `automation:${RUN}`) => {
    const provider = connection === "facebook-1" ? "facebook" : "website";
    const draft = `draft-${id}`;
    h.sqlite.prepare(`INSERT INTO content_drafts
      (id,workspace_id,product_id,target_provider,content_type,title,body,platform_data_json,status,version,created_at,updated_at)
      VALUES (?,?,'product-1',?,'product_listing','Giày PH0001','Nội dung đã duyệt',?,'approved',1,?,?)`)
      .run(draft, WORKSPACE, provider, JSON.stringify({ automationRunId: RUN }), NOW, NOW);
    h.sqlite.prepare(`INSERT INTO schedules
      (id,workspace_id,draft_id,connection_id,status,schedule_kind,run_at,next_run_at,execution_mode,created_by,created_at,updated_at)
      VALUES (?,?,?,?,'active','once',?,?,'auto',?,?,?)`)
      .run(id, WORKSPACE, draft, connection, NOW - 1000, NOW - 1000, createdBy, NOW - 2000, NOW - 2000);
  };
  const addJob = (id, connection, status = "queued", overrides = {}) => {
    h.sqlite.prepare(`INSERT INTO publish_jobs
      (id,workspace_id,connection_id,product_id,job_kind,dedupe_key,status,scheduled_for,available_at,
       payload_snapshot_json,created_at,updated_at,lease_owner,lease_expires_at,external_post_id,error_code)
      VALUES (?,?,?,'product-1','listing_upsert',?,?,?,?,?,?,?,'old-worker',?,?,?)`)
      .run(id, WORKSPACE, connection, `dedupe-${id}`, status, NOW - 5000, NOW - 5000,
        JSON.stringify({ message: "Giày PH0001", mediaIds: [] }), NOW - 5000, NOW - 5000,
        status === "publishing" ? NOW - 1 : null, overrides.externalId ?? null, overrides.errorCode ?? null);
  };
  h.overrides.set(path.join(ROOT, "lib/publish-media-integrity.ts"), { assertPublishProductMedia: async () => {} });
  const sends = [];
  const forbidden = async () => { throw new Error("Unrelated provider must not execute"); };
  const publishers = {
    website: async (input) => { sends.push(input); return { externalId: "507f1f77bcf86cd799439011", externalUrl: "https://tahashoes.vn/product/507f1f77bcf86cd799439011", providerResponse: {} }; },
    facebook: forbidden, recordFacebook: forbidden, tiktokShop: forbidden, recordTikTokShop: forbidden,
  };
  return { ...h, addSchedule, addJob, sends, publishers };
}

test("normal website automation with imageCount zero uses source images and never creates an image step", async () => {
  const h = seed();
  // The harness throws if either external image-generation function is invoked.
  const automation = h.load("lib/automation.ts");
  const input = { productId: "product-1", targetProviders: ["website"], connectionIds: { website: "website-1" },
    imageCount: 0, idempotencyKey: "source-only-website-trial", prepareOnly: false };
  const queued = await automation.queueAutomationRun(input);
  for (let index = 0; index < 3; index += 1) {
    await automation.runAutomationWorker({ runIds: [queued.run.id], limit: 1 });
  }
  const run = h.sqlite.prepare("SELECT * FROM automation_runs WHERE id=?").get(queued.run.id);
  assert.equal(run.status, "completed");
  assert.equal(run.requested_image_count, 0);
  assert.equal(run.completed_image_count, 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) count FROM automation_steps WHERE run_id=? AND step_type='image'").get(queued.run.id).count, 0);
  const media = h.sqlite.prepare(`SELECT m.media_id FROM content_draft_media m JOIN content_drafts d ON d.id=m.draft_id
    WHERE json_extract(d.platform_data_json,'$.automationRunId')=?`).all(queued.run.id);
  assert.deepEqual(media.map(row => row.media_id), ["image-product-1"]);
  const replay = await automation.queueAutomationRun(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.id, queued.run.id);
});

test("bounded website delivery leaves older schedules/jobs, expired leases and TikTok mapping receipts unchanged", async () => {
  const h = seed();
  h.addSchedule("trial-schedule");
  h.addSchedule("older-facebook", "facebook-1", "operator");
  h.addSchedule("older-website", "website-1", "operator");
  h.addJob("older-ready", "website-1");
  h.addJob("expired-website", "website-1", "publishing");
  h.addJob("expired-facebook", "facebook-1", "publishing");
  h.addJob("tiktok-mapping", "tiktok-1", "blocked", { externalId: "remote-tiktok", errorCode: "TIKTOK_MAPPING_PENDING" });
  const snapshots = () => ({
    schedules: h.sqlite.prepare("SELECT * FROM schedules WHERE id!='trial-schedule' ORDER BY id").all(),
    jobs: h.sqlite.prepare("SELECT * FROM publish_jobs WHERE schedule_id IS NULL ORDER BY id").all(),
  });
  const before = snapshots();
  const { deliverWebsiteAutomationRun } = h.load("lib/website-delivery.ts");
  const first = await deliverWebsiteAutomationRun(RUN, { database: h.db, publishers: h.publishers, now: NOW });
  assert.equal(first.job.status, "published");
  assert.equal(first.scheduler.checked, 1);
  assert.equal(first.dispatcher.checked, 1);
  assert.equal(first.dispatcher.recoveredRetrying, 0);
  assert.equal(first.dispatcher.recoveredBlocked, 0);
  assert.equal(first.dispatcher.reconciledMappings, 0);
  assert.equal(h.sends.length, 1);
  assert.deepEqual(snapshots(), before);
  const replay = await deliverWebsiteAutomationRun(RUN, { database: h.db, publishers: h.publishers, now: NOW + 1 });
  assert.equal(replay.replayed, true);
  assert.equal(h.sends.length, 1, "same completed run must not publish again");
  assert.deepEqual(snapshots(), before);
});

test("filtered dispatcher recovers only the selected expired website lease", async () => {
  const h = seed();
  h.addJob("target-expired", "website-1", "publishing");
  h.addJob("other-expired", "website-1", "publishing");
  h.addJob("other-social-expired", "facebook-1", "publishing");
  const before = h.sqlite.prepare("SELECT * FROM publish_jobs WHERE id!='target-expired' ORDER BY id").all();
  const { runPublishDispatcher } = h.load("lib/dispatcher.ts");
  const result = await runPublishDispatcher({ database: h.db, publishers: h.publishers, now: NOW, jobIds: ["target-expired"] });
  assert.equal(result.published, 1);
  assert.equal(result.recoveredRetrying, 1);
  assert.equal(result.recoveredBlocked, 0);
  assert.deepEqual(h.sqlite.prepare("SELECT * FROM publish_jobs WHERE id!='target-expired' ORDER BY id").all(), before);
});

test("empty, duplicate and SQL-shaped filters fail before any database operations", async () => {
  const h = seed();
  const { runSchedulerTick } = h.load("lib/scheduler.ts");
  const { runPublishDispatcher } = h.load("lib/dispatcher.ts");
  const database = { prepare() { throw new Error("Database must not be touched"); } };
  for (const ids of [[], ["one", "one"], ["id') OR 1=1--"], Array.from({ length: 51 }, (_, i) => `id${i}`)]) {
    await assert.rejects(runSchedulerTick({ database, scheduleIds: ids }), /SCHEDULER_FILTER_INVALID/);
    await assert.rejects(runPublishDispatcher({ database, jobIds: ids }), /DISPATCHER_FILTER_INVALID/);
  }
});

test("website route rejects unauthorized requests and cross-channel, generated-image or connection-mismatched runs", async () => {
  const h = seed();
  h.addSchedule("trial-schedule");
  const route = h.load("app/api/internal/website/deliver/route.ts");
  const request = (body, token = "test-internal-secret") => new Request("https://app.test/api/internal/website/deliver", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await route.POST(request({ runId: RUN }, "wrong"))).status, 401);
  assert.equal((await route.POST(request({ runId: RUN, jobIds: ["other"] }))).status, 400);
  assert.equal((await route.POST(request({ runId: "invalid-id" }))).status, 400);
  for (const mutation of [
    "UPDATE automation_runs SET target_providers_json='[\"website\",\"facebook\"]'",
    "UPDATE automation_runs SET target_providers_json='[\"website\"]',requested_image_count=1",
    "UPDATE automation_runs SET requested_image_count=0,status='processing'",
  ]) {
    h.sqlite.exec(mutation);
    const response = await route.POST(request({ runId: RUN }));
    assert.equal(response.status, 409);
  }
  h.sqlite.exec("UPDATE automation_runs SET status='completed'; UPDATE schedules SET connection_id='facebook-1'");
  assert.equal((await route.POST(request({ runId: RUN }))).status, 409);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS count FROM publish_jobs").get().count, 0);
});

test("bounded route refuses a previous publication attempt instead of requeueing uncertain delivery", async () => {
  const h = seed();
  h.addSchedule("trial-schedule");
  const { runSchedulerTick } = h.load("lib/scheduler.ts");
  await runSchedulerTick({ database: h.db, now: NOW, scheduleIds: ["trial-schedule"] });
  h.sqlite.exec("UPDATE publish_jobs SET status='retry_wait',attempt_count=1,error_code='WEBSITE_RESPONSE_INVALID'");
  const before = h.sqlite.prepare("SELECT * FROM publish_jobs").all();
  const { deliverWebsiteAutomationRun } = h.load("lib/website-delivery.ts");
  await assert.rejects(deliverWebsiteAutomationRun(RUN, { database: h.db, publishers: h.publishers, now: NOW }),
    /WEBSITE_DELIVERY_OUTCOME_REQUIRES_REVIEW/);
  assert.equal(h.sends.length, 0);
  assert.deepEqual(h.sqlite.prepare("SELECT * FROM publish_jobs").all(), before);
});

test("a concurrent scoped call cannot resend while the first request holds the publication lease", async () => {
  const h = seed();
  h.addSchedule("trial-schedule");
  let release;
  let started;
  const inFlight = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const send = h.publishers.website;
  h.publishers.website = async input => {
    const receipt = await send(input);
    started();
    await gate;
    return receipt;
  };
  const { deliverWebsiteAutomationRun } = h.load("lib/website-delivery.ts");
  const first = deliverWebsiteAutomationRun(RUN, { database: h.db, publishers: h.publishers, now: NOW });
  await inFlight;
  await assert.rejects(deliverWebsiteAutomationRun(RUN, { database: h.db, publishers: h.publishers, now: NOW }),
    /WEBSITE_DELIVERY_OUTCOME_REQUIRES_REVIEW/);
  release();
  assert.equal((await first).job.status, "published");
  assert.equal(h.sends.length, 1);
  const jobs = h.sqlite.prepare("SELECT status,attempt_count FROM publish_jobs").all();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].attempt_count, 1);
});

test("persisted receipts remain generic across websites but incomplete receipts never produce success", async () => {
  const h = seed();
  h.addSchedule("trial-schedule");
  const { runSchedulerTick } = h.load("lib/scheduler.ts");
  await runSchedulerTick({ database: h.db, now: NOW, scheduleIds: ["trial-schedule"] });
  h.sqlite.prepare("UPDATE publish_jobs SET status='published',external_post_id=?,external_url=?")
    .run("custom-product-123", "https://another-shop.example/items/custom-product-123");
  const { deliverWebsiteAutomationRun } = h.load("lib/website-delivery.ts");
  const replay = await deliverWebsiteAutomationRun(RUN, { database: h.db, publishers: h.publishers, now: NOW });
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.external_post_id, "custom-product-123");
  h.sqlite.exec("UPDATE publish_jobs SET external_post_id=' '");
  await assert.rejects(deliverWebsiteAutomationRun(RUN, { database: h.db, publishers: h.publishers, now: NOW }),
    /WEBSITE_DELIVERY_RECEIPT_INVALID/);
  assert.equal(h.sends.length, 0);
});

test("failed website delivery does not return a successful endpoint result", async () => {
  const h = seed();
  h.addSchedule("trial-schedule");
  h.publishers.website = async () => { throw new Error("WEBSITE_NETWORK_ERROR"); };
  const { deliverWebsiteAutomationRun } = h.load("lib/website-delivery.ts");
  await assert.rejects(deliverWebsiteAutomationRun(RUN, { database: h.db, publishers: h.publishers, now: NOW }),
    /WEBSITE_DELIVERY_OUTCOME_REQUIRES_REVIEW/);
  assert.equal(h.sqlite.prepare("SELECT status FROM publish_jobs").get().status, "retry_wait");
});
