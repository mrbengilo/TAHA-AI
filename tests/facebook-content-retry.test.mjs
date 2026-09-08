import assert from "node:assert/strict";
import test from "node:test";
import { harness as sqliteHarness, WORKSPACE } from "./sqlite-harness.mjs";

function prepareFailedJob(options = {}) {
  const h = sqliteHarness();
  h.seedProduct();
  const now = Date.now();
  const draftId = "draft-facebook-policy";
  const scheduleId = "schedule-facebook-policy";
  const jobId = "job-facebook-policy";
  const platformData = { sourceImageCount: 1, generatedImageCount: 0 };
  h.sqlite.prepare(`INSERT INTO content_drafts
    (id,workspace_id,product_id,target_provider,content_type,title,body,hashtags_json,platform_data_json,status,version,generation_meta_json,created_at,updated_at)
    VALUES (?,?,?,'facebook','social_post',?,?,?,?,?,1,'{}',?,?)`)
    .run(draftId, WORKSPACE, "product-1", "Giày PH0001", "Giá bán: 490.000 VND", JSON.stringify(["TAHA"]),
      JSON.stringify(platformData), options.draftStatus ?? "approved", now, now);
  h.sqlite.prepare(`INSERT INTO content_draft_media
    (id,workspace_id,draft_id,media_id,role,sort_order,created_at) VALUES (?,?,?,?,'primary',0,?)`)
    .run("draft-media-facebook-policy", WORKSPACE, draftId, "image-product-1", now);
  h.sqlite.prepare(`INSERT INTO schedules
    (id,workspace_id,draft_id,connection_id,status,schedule_kind,run_at,next_run_at,timezone,execution_mode,created_at,updated_at)
    VALUES (?,?,?,'facebook-1','completed','once',?,NULL,'Asia/Ho_Chi_Minh','auto',?,?)`)
    .run(scheduleId, WORKSPACE, draftId, now - 60_000, now, now);
  const payload = {
    draftVersion: 1, productId: "product-1", draftId, scheduleId, provider: "facebook",
    contentType: "social_post", title: "Giày PH0001", message: "Giá bán: 490.000 VND",
    hashtags: ["TAHA"], platformData, mediaIds: ["image-product-1"], occurrenceAt: now - 60_000,
  };
  h.sqlite.prepare(`INSERT INTO publish_jobs
    (id,workspace_id,schedule_id,connection_id,product_id,draft_id,job_kind,dedupe_key,status,scheduled_for,available_at,
     payload_snapshot_json,attempt_count,max_attempts,provider_response_json,error_code,error_message,completed_at,created_at,updated_at)
    VALUES (?,?,?,'facebook-1','product-1',?,'social_post','schedule:schedule-facebook-policy:occurrence',?,?,?,?,5,5,?,?,?,?,?,?)`)
    .run(jobId, WORKSPACE, scheduleId, draftId, options.jobStatus ?? "failed", now - 60_000, now - 60_000,
      JSON.stringify(payload), options.providerResponse ?? "{}", options.errorCode ?? "CONTENT_PRICE_FORBIDDEN",
      "Không thể xuất bản sau số lần thử cho phép.", now, now, now);
  return { ...h, now, draftId, scheduleId, jobId };
}

async function correctDraft(h) {
  return h.load("lib/content-review.ts").reviewContentDraft(h.draftId, {
    action: "edit", version: 1, title: "Giày PH0001 mới",
    body: "Mẫu PH0001 đã sẵn sàng cho bạn.", hashtags: ["TAHA", "PH0001"],
  }, "admin");
}

function publishers(sent) {
  return {
    async facebook(input) {
      sent.push(input);
      return { externalId: "facebook-post-1", externalUrl: "https://facebook.example/post-1", providerResponse: { id: "facebook-post-1" } };
    },
    async recordFacebook() { return true; },
    async recordTikTokShop() { return true; },
  };
}

test("explicit retry refreshes the corrected snapshot and dispatches the same Facebook job once", async () => {
  const h = prepareFailedJob();
  await correctDraft(h);
  const original = h.sqlite.prepare("SELECT id,dedupe_key,payload_snapshot_json FROM publish_jobs WHERE id=?").get(h.jobId);
  assert.match(JSON.parse(original.payload_snapshot_json).message, /490\.000/);

  const retry = await h.load("lib/content-review.ts").scheduleReviewedDraft(h.draftId, "facebook-1", "facebook");
  assert.deepEqual({ ...retry }, { scheduleId: h.scheduleId, status: "queued", replayed: false });
  const queued = h.sqlite.prepare("SELECT * FROM publish_jobs WHERE id=?").get(h.jobId);
  const snapshot = JSON.parse(queued.payload_snapshot_json);
  assert.equal(queued.id, original.id);
  assert.equal(queued.dedupe_key, original.dedupe_key);
  assert.equal(queued.status, "queued");
  assert.equal(queued.attempt_count, 0);
  assert.equal(queued.error_code, null);
  assert.equal(snapshot.draftVersion, 2);
  assert.equal(snapshot.title, "Giày PH0001 mới");
  assert.equal(snapshot.message, "Mẫu PH0001 đã sẵn sàng cho bạn.");
  assert.deepEqual(snapshot.hashtags, ["TAHA", "PH0001"]);
  assert.deepEqual(snapshot.mediaIds, ["image-product-1"]);

  const replay = await h.load("lib/content-review.ts").scheduleReviewedDraft(h.draftId, "facebook-1", "facebook");
  assert.deepEqual({ ...replay }, { scheduleId: h.scheduleId, status: "queued", replayed: true });
  const sent = [];
  const result = await h.load("lib/dispatcher.ts").runPublishDispatcher({ now: queued.available_at, publishers: publishers(sent) });
  assert.equal(result.published, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /Mẫu PH0001 đã sẵn sàng/);
  await h.load("lib/dispatcher.ts").runPublishDispatcher({ now: queued.available_at + 1, publishers: publishers(sent) });
  assert.equal(sent.length, 1);
});

test("published Facebook jobs remain idempotent and are never rearmed", async () => {
  const h = prepareFailedJob({ jobStatus: "published", errorCode: null, providerResponse: JSON.stringify({ id: "already-posted" }) });
  h.sqlite.prepare("UPDATE publish_jobs SET external_post_id='already-posted', external_url='https://facebook.example/already' WHERE id=?").run(h.jobId);
  h.sqlite.prepare("UPDATE content_drafts SET body='Nội dung hợp lệ PH0001' WHERE id=?").run(h.draftId);
  const result = await h.load("lib/content-review.ts").scheduleReviewedDraft(h.draftId, "facebook-1", "facebook");
  assert.deepEqual({ ...result }, { scheduleId: h.scheduleId, status: "published", replayed: true });
  const row = h.sqlite.prepare("SELECT status,external_post_id,dedupe_key FROM publish_jobs WHERE id=?").get(h.jobId);
  assert.equal(row.status, "published");
  assert.equal(row.external_post_id, "already-posted");
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM publish_jobs").get().n, 1);
});

test("retry refuses remote receipts, unknown outcomes, and unrelated failures", async (t) => {
  for (const scenario of [
    { name: "external receipt", options: { providerResponse: JSON.stringify({ id: "maybe-posted" }) }, code: "FACEBOOK_RETRY_REQUIRES_RECONCILIATION" },
    { name: "unknown outcome", options: { jobStatus: "blocked", errorCode: "DELIVERY_OUTCOME_UNKNOWN" }, code: "FACEBOOK_RETRY_REQUIRES_RECONCILIATION" },
    { name: "unrelated failure", options: { errorCode: "FACEBOOK_API_400" }, code: "FACEBOOK_RETRY_NOT_ALLOWED" },
  ]) await t.test(scenario.name, async () => {
    const h = prepareFailedJob(scenario.options);
    if (scenario.options.jobStatus === "blocked") {
      h.sqlite.prepare("UPDATE content_drafts SET body='Nội dung hợp lệ PH0001', version=2 WHERE id=?").run(h.draftId);
    } else {
      await correctDraft(h);
    }
    await assert.rejects(
      h.load("lib/content-review.ts").scheduleReviewedDraft(h.draftId, "facebook-1", "facebook"),
      (error) => error.code === scenario.code,
    );
    assert.equal(h.sqlite.prepare("SELECT status FROM publish_jobs WHERE id=?").get(h.jobId).status, scenario.options.jobStatus ?? "failed");
  });
});

test("admin rejection and a concurrent retry cannot rearm the failed job twice", async (t) => {
  await t.test("admin rejection", async () => {
    const h = prepareFailedJob();
    await h.load("lib/content-review.ts").reviewContentDraft(h.draftId, { action: "reject", version: 1 }, "admin");
    await assert.rejects(
      h.load("lib/content-review.ts").scheduleReviewedDraft(h.draftId, "facebook-1", "facebook"),
      (error) => error.code === "DRAFT_NOT_APPROVED",
    );
    assert.equal(h.sqlite.prepare("SELECT status FROM publish_jobs WHERE id=?").get(h.jobId).status, "failed");
  });

  await t.test("concurrent retry", async () => {
    const h = prepareFailedJob();
    await correctDraft(h);
    h.hooks.beforeFirst = async (sql) => {
      if (!sql.startsWith("UPDATE publish_jobs SET")) return;
      h.hooks.beforeFirst = null;
      h.sqlite.prepare("UPDATE publish_jobs SET status='queued', error_code=NULL, error_message=NULL WHERE id=?").run(h.jobId);
    };
    const result = await h.load("lib/content-review.ts").scheduleReviewedDraft(h.draftId, "facebook-1", "facebook");
    assert.deepEqual({ ...result }, { scheduleId: h.scheduleId, status: "queued", replayed: true });
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM publish_jobs").get().n, 1);
  });
});

test("retry aborts if the validated media selection changes before the atomic update", async () => {
  const h = prepareFailedJob();
  await correctDraft(h);
  h.seedProduct("product-2", "PH0002");
  h.hooks.beforeFirst = async (sql) => {
    if (!sql.startsWith("UPDATE publish_jobs SET")) return;
    h.hooks.beforeFirst = null;
    h.sqlite.prepare("DELETE FROM content_draft_media WHERE draft_id=?").run(h.draftId);
    h.sqlite.prepare(`INSERT INTO content_draft_media
      (id,workspace_id,draft_id,media_id,role,sort_order,created_at) VALUES (?,?,?,?,'primary',0,?)`)
      .run("raced-draft-media", WORKSPACE, h.draftId, "image-product-2", Date.now());
  };
  await assert.rejects(
    h.load("lib/content-review.ts").scheduleReviewedDraft(h.draftId, "facebook-1", "facebook"),
    (error) => error.code === "CONTENT_REVIEW_CONFLICT",
  );
  assert.equal(h.sqlite.prepare("SELECT status FROM publish_jobs WHERE id=?").get(h.jobId).status, "failed");
});

test("a receipt or in-flight job on another schedule blocks the retry", async (t) => {
  for (const status of ["published", "publishing"]) await t.test(status, async () => {
    const h = prepareFailedJob();
    h.sqlite.prepare("UPDATE content_drafts SET body='Nội dung hợp lệ PH0001', version=2 WHERE id=?").run(h.draftId);
    const competingSchedule = `competing-schedule-${status}`;
    h.sqlite.prepare(`INSERT INTO schedules
      (id,workspace_id,draft_id,connection_id,status,schedule_kind,run_at,next_run_at,timezone,execution_mode,created_at,updated_at)
      VALUES (?,?,?,'facebook-1','completed','once',?,NULL,'Asia/Ho_Chi_Minh','auto',?,?)`)
      .run(competingSchedule, WORKSPACE, h.draftId, h.now - 180_000, h.now - 180_000, h.now - 180_000);
    h.sqlite.prepare(`INSERT INTO publish_jobs
      (id,workspace_id,schedule_id,connection_id,product_id,draft_id,job_kind,dedupe_key,status,scheduled_for,available_at,
       payload_snapshot_json,attempt_count,max_attempts,provider_response_json,external_post_id,created_at,updated_at)
      VALUES (?,?,?,'facebook-1','product-1',?,'social_post',?,?,?,?,? ,1,5,?,?,?,?)`)
      .run(`competing-job-${status}`, WORKSPACE, competingSchedule, h.draftId,
        `schedule:${competingSchedule}:occurrence`, status, h.now - 180_000, h.now - 180_000, "{}",
        status === "published" ? JSON.stringify({ id: "existing-post" }) : "{}",
        status === "published" ? "existing-post" : null, h.now - 180_000, h.now - 180_000);
    await assert.rejects(
      h.load("lib/content-review.ts").scheduleReviewedDraft(h.draftId, "facebook-1", "facebook"),
      (error) => error.code === "FACEBOOK_RETRY_REQUIRES_RECONCILIATION",
    );
    assert.equal(h.sqlite.prepare("SELECT status FROM publish_jobs WHERE id=?").get(h.jobId).status, "failed");
  });
});
