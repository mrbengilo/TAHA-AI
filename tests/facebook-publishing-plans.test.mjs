import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { harness, ROOT, WORKSPACE } from "./sqlite-harness.mjs";

test("admin Facebook day plan persists exact unique times and enables daily automation", async () => {
  const h = harness();
  const plans = h.load("lib/facebook-publishing-plans.ts");
  const now = Date.UTC(2099, 0, 8, 0, 0);
  const saved = await plans.saveFacebookPublishingPlan({
    date: "2099-01-10",
    postCount: 3,
    times: ["18:00", "08:00", "12:00"],
  }, now);
  assert.deepEqual(saved.plan.times, ["08:00", "12:00", "18:00"]);
  const config = JSON.parse(h.sqlite.prepare("SELECT config_json FROM channel_connections WHERE id='facebook-1'").get().config_json);
  assert.equal(config.dailyAutomationEnabled, 1);
  assert.deepEqual(config.facebookPublishingPlans[0], {
    date: "2099-01-10",
    times: ["08:00", "12:00", "18:00"],
    updatedAt: now,
  });

  await assert.rejects(
    plans.saveFacebookPublishingPlan({ date: "2099-01-11", postCount: 3, times: ["08:00", "12:00"] }, now),
    (error) => error.code === "POST_COUNT_MISMATCH",
  );
  await assert.rejects(
    plans.saveFacebookPublishingPlan({ date: "2099-01-11", postCount: 2, times: ["08:00", "08:00"] }, now),
    (error) => error.code === "DUPLICATE_TIME",
  );
});

test("Facebook day plan refuses ambiguous Page targets", async () => {
  const h = harness();
  h.sqlite.prepare(`INSERT INTO channel_connections
    (id,workspace_id,provider,role,display_name,status,publish_mode,created_at,updated_at)
    VALUES ('facebook-2',?,'facebook','publisher','Other Page','connected','api',1,2)`).run(WORKSPACE);
  const plans = h.load("lib/facebook-publishing-plans.ts");
  await assert.rejects(
    plans.saveFacebookPublishingPlan({ date: "2099-01-10", postCount: 1, times: ["08:00"] }, Date.UTC(2099, 0, 8)),
    (error) => error.code === "FACEBOOK_CONNECTION_AMBIGUOUS",
  );
});

test("three Facebook slots materialize distinct products and exact Vietnam timestamps idempotently", async () => {
  const h = harness();
  h.seedProduct("product-1", "PH0001");
  h.seedProduct("product-2", "PH0002");
  h.seedProduct("product-3", "PH0003");
  h.overrides.set(path.join(ROOT, "lib/integrations/facebook-permissions.ts"), {
    verifyFacebookConnection: async () => ({ ready: true }),
  });
  h.sqlite.prepare("UPDATE channel_connections SET config_json=? WHERE id='facebook-1'").run(JSON.stringify({
    dailyAutomationEnabled: 1,
    facebookPublishingPlans: [{ date: "2099-01-10", times: ["08:00", "12:00", "18:00"], updatedAt: 1 }],
  }));
  const daily = h.load("lib/daily-automation.ts");
  const now = Date.UTC(2099, 0, 9, 22, 0); // 05:00 ngày 10/01 tại Việt Nam.
  for (const expectedTime of ["08:00", "12:00", "18:00"]) {
    const outcome = await daily.ensureDailyProductAutomation(now);
    assert.equal(outcome.queued, true, JSON.stringify(outcome));
    assert.equal(outcome.time, expectedTime);
  }
  const fourth = await daily.ensureDailyProductAutomation(now);
  assert.equal(fourth.queued, false);
  assert.equal(fourth.reason, "already_planned");

  const runs = h.sqlite.prepare("SELECT product_id,request_key,content_json FROM automation_runs ORDER BY request_key").all();
  assert.equal(new Set(runs.map((run) => run.product_id)).size, 3);
  assert.deepEqual(runs.map((run) => JSON.parse(run.content_json).scheduledFor).sort(), [
    Date.UTC(2099, 0, 10, 1, 0),
    Date.UTC(2099, 0, 10, 5, 0),
    Date.UTC(2099, 0, 10, 11, 0),
  ]);
  const automation = h.load("lib/automation.ts");
  for (let index = 0; index < 12; index += 1) await automation.runAutomationWorker({ limit: 8 });
  const schedules = h.sqlite.prepare("SELECT run_at,timezone,status FROM schedules ORDER BY run_at").all();
  assert.deepEqual(schedules.map((schedule) => schedule.run_at), [
    Date.UTC(2099, 0, 10, 1, 0),
    Date.UTC(2099, 0, 10, 5, 0),
    Date.UTC(2099, 0, 10, 11, 0),
  ]);
  assert.ok(schedules.every((schedule) => schedule.timezone === "Asia/Ho_Chi_Minh" && schedule.status === "active"));
  const changed = await h.load("lib/facebook-publishing-plans.ts").saveFacebookPublishingPlan(
    { date: "2099-01-10", postCount: 2, times: ["08:00", "18:00"] },
    now + 1,
  );
  assert.equal(changed.reconciledSchedules, 1);
  assert.equal(h.sqlite.prepare("SELECT status FROM schedules WHERE run_at=?").get(Date.UTC(2099, 0, 10, 5, 0)).status, "paused");
});

test("editing a day plan cancels unmaterialized old slots and allows newly added times", async () => {
  const h = harness();
  h.seedProduct("product-1", "PH0001");
  h.seedProduct("product-2", "PH0002");
  h.seedProduct("product-3", "PH0003");
  h.overrides.set(path.join(ROOT, "lib/integrations/facebook-permissions.ts"), {
    verifyFacebookConnection: async () => ({ ready: true }),
  });
  const now = Date.UTC(2099, 0, 9, 22, 0);
  const plans = h.load("lib/facebook-publishing-plans.ts");
  await plans.saveFacebookPublishingPlan({ date: "2099-01-10", postCount: 2, times: ["08:00", "12:00"] }, now);
  const daily = h.load("lib/daily-automation.ts");
  assert.equal((await daily.ensureDailyProductAutomation(now)).time, "08:00");
  assert.equal((await daily.ensureDailyProductAutomation(now)).time, "12:00");

  const changed = await plans.saveFacebookPublishingPlan(
    { date: "2099-01-10", postCount: 2, times: ["08:00", "18:00"] },
    now + 1,
  );
  assert.equal(changed.reconciledRuns, 1);
  const states = h.sqlite.prepare("SELECT request_key,status FROM automation_runs ORDER BY request_key").all();
  assert.equal(states.find((run) => run.request_key.includes(":0800:"))?.status, "queued");
  assert.equal(states.find((run) => run.request_key.includes(":1200:"))?.status, "cancelled");
  const added = await daily.ensureDailyProductAutomation(now + 1);
  assert.equal(added.queued, true);
  assert.equal(added.time, "18:00");
  assert.equal(new Set(h.sqlite.prepare("SELECT product_id FROM automation_runs WHERE status!='cancelled'").all().map((row) => row.product_id)).size, 2);
});
