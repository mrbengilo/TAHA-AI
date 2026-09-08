import assert from "node:assert/strict";
import test from "node:test";
import { harness, WORKSPACE } from "./sqlite-harness.mjs";

function seedReadyFacebookDraft(h, productId = "product-1", suffix = "one") {
  const now = Date.now();
  const id = `facebook-ready-${suffix}`;
  h.sqlite.prepare(`INSERT INTO content_drafts
    (id,workspace_id,product_id,target_provider,content_type,title,body,hashtags_json,platform_data_json,status,version,created_at,updated_at)
    VALUES (?,?,?,'facebook','social_post',?,?,?,?,'approved',1,?,?)`)
    .run(id, WORKSPACE, productId, `Bài ${suffix}`, `Facebook ${suffix}`,
      JSON.stringify(["PH0001"]), JSON.stringify({ productDescription: `Mô tả website ${suffix}` }), now, now);
  h.sqlite.prepare(`INSERT INTO content_draft_media
    (id,workspace_id,draft_id,media_id,role,sort_order,created_at) VALUES (?,?,?,?,'primary',0,?)`)
    .run(`draft-media-${suffix}`, WORKSPACE, id, `image-${productId}`, now);
  return id;
}

test("queues every ready product for immediate website publishing and is replay-safe", async () => {
  const h = harness();
  h.seedProduct();
  h.sqlite.prepare(`INSERT INTO channel_connections
    (id,workspace_id,provider,role,display_name,status,publish_mode,created_at,updated_at)
    VALUES ('website-1',?,'website','both','tahashoes.vn','connected','api',?,?)`).run(WORKSPACE, Date.now(), Date.now());
  const sourceId = seedReadyFacebookDraft(h);
  const backfill = h.load("lib/website-backfill.ts");
  const first = await backfill.ensureWebsiteReadyBackfill({ database: h.db, enabled: true, now: 1_800_000_000_000 });
  assert.deepEqual(JSON.parse(JSON.stringify(first)), { enabled: true, checked: 1, queued: 1, skipped: 0 });
  const draft = h.sqlite.prepare("SELECT * FROM content_drafts WHERE target_provider='website'").get();
  assert.equal(draft.content_type, "product_listing");
  assert.equal(draft.status, "approved");
  assert.equal(draft.title, "Giày PH0001");
  assert.equal(draft.body, "Mô tả website one");
  assert.equal(JSON.parse(draft.platform_data_json).websiteSourceDraftId, sourceId);
  const schedule = h.sqlite.prepare("SELECT * FROM schedules WHERE draft_id=?").get(draft.id);
  assert.equal(schedule.run_at, 1_800_000_000_000);
  assert.equal(schedule.next_run_at, 1_800_000_000_000);
  assert.equal(schedule.status, "active");

  const replay = await backfill.ensureWebsiteReadyBackfill({ database: h.db, enabled: true, now: 1_800_000_000_100 });
  assert.deepEqual(JSON.parse(JSON.stringify(replay)), { enabled: true, checked: 0, queued: 0, skipped: 0 });
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM content_drafts WHERE target_provider='website'").get().n, 1);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM schedules WHERE connection_id='website-1'").get().n, 1);
});

test("does nothing while the website receiver flag is disabled", async () => {
  const h = harness();
  const backfill = h.load("lib/website-backfill.ts");
  const result = await backfill.ensureWebsiteReadyBackfill({ database: h.db, enabled: false });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { enabled: false, checked: 0, queued: 0, skipped: 0, reason: "disabled" });
});
