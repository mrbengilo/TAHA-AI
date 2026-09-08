import assert from "node:assert/strict";
import test from "node:test";
import { harness, WORKSPACE } from "./sqlite-harness.mjs";

function seedPublishedFacebook(h, id, sku) {
  const product = h.seedProduct(id, sku);
  const draftId = `draft-${id}`;
  h.sqlite.prepare(`INSERT INTO content_drafts
    (id,workspace_id,product_id,target_provider,content_type,language,title,body,hashtags_json,platform_data_json,
     status,version,generator,prompt_version,generation_meta_json,approved_by,approved_at,created_at,updated_at)
    VALUES (?,?,?,'facebook','social_post','vi',?,'Nội dung Facebook','[]','{}','approved',1,'openai','source-only-v1','{}','admin',1,1,1)`)
    .run(draftId, WORKSPACE, id, `Giày ${sku}`);
  h.sqlite.prepare(`INSERT INTO content_draft_media
    (id,workspace_id,draft_id,media_id,role,sort_order,created_at) VALUES (?,?,?,?, 'primary',0,1)`)
    .run(`cdm-${id}`, WORKSPACE, draftId, product.mediaId);
  h.sqlite.prepare(`INSERT INTO publish_jobs
    (id,workspace_id,connection_id,product_id,draft_id,job_kind,dedupe_key,status,scheduled_for,available_at,
     payload_snapshot_json,external_post_id,provider_response_json,completed_at,created_at,updated_at)
    VALUES (?,?, 'facebook-1',?,?,'social_post',?,'published',1,1,'{}',?,'{}',10,1,10)`)
    .run(`job-${id}`, WORKSPACE, id, draftId, `published-${id}`, `fb-${id}`);
  return { product, draftId };
}

test("Facebook repost lists only successful products, schedules once, and replays the exact product/time", async () => {
  const h = harness();
  seedPublishedFacebook(h, "product-1", "PH0001");
  h.seedProduct("never-published", "PH0002");
  const reposts = h.load("lib/facebook-reposts.ts");
  const listed = await reposts.listFacebookRepostProducts();
  assert.deepEqual(listed.products.map((product) => product.id), ["product-1"]);

  const now = Date.UTC(2099, 0, 8, 0, 0);
  const first = await reposts.scheduleFacebookRepost({
    productId: "product-1",
    date: "2099-01-10",
    time: "08:00",
  }, "admin-1", now);
  assert.equal(first.status, "active");
  assert.equal(first.replayed, false);
  assert.equal(first.scheduledFor, Date.UTC(2099, 0, 10, 1, 0));
  const row = h.sqlite.prepare("SELECT run_at,timezone,publish_options_json,status FROM schedules WHERE id=?").get(first.scheduleId);
  assert.equal(row.run_at, first.scheduledFor);
  assert.equal(row.timezone, "Asia/Ho_Chi_Minh");
  assert.equal(row.status, "active");
  assert.equal(JSON.parse(row.publish_options_json).repostProductId, "product-1");

  const replay = await reposts.scheduleFacebookRepost({
    productId: "product-1",
    date: "2099-01-10",
    time: "08:00",
  }, "admin-1", now);
  assert.equal(replay.replayed, true);
  assert.equal(replay.scheduleId, first.scheduleId);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS total FROM schedules").get().total, 1);
});

test("Facebook repost rejects unpublished products and exact-time collisions", async () => {
  const h = harness();
  seedPublishedFacebook(h, "product-1", "PH0001");
  seedPublishedFacebook(h, "product-2", "PH0002");
  const reposts = h.load("lib/facebook-reposts.ts");
  const now = Date.UTC(2099, 0, 8, 0, 0);
  h.sqlite.prepare("UPDATE channel_connections SET config_json=? WHERE id='facebook-1'").run(JSON.stringify({
    facebookPublishingPlans: [{ date: "2099-01-10", times: ["12:00"], updatedAt: now }],
  }));
  await assert.rejects(
    reposts.scheduleFacebookRepost({ productId: "product-2", date: "2099-01-10", time: "12:00" }, "admin", now),
    (error) => error.code === "FACEBOOK_TIME_COLLISION",
  );
  await reposts.scheduleFacebookRepost({ productId: "product-1", date: "2099-01-10", time: "08:00" }, "admin", now);
  await assert.rejects(
    reposts.scheduleFacebookRepost({ productId: "product-2", date: "2099-01-10", time: "08:00" }, "admin", now),
    (error) => error.code === "FACEBOOK_TIME_COLLISION",
  );
  await assert.rejects(
    reposts.scheduleFacebookRepost({ productId: "missing", date: "2099-01-10", time: "12:00" }, "admin", now),
    (error) => error.code === "FACEBOOK_REPOST_SOURCE_REQUIRED",
  );
});
