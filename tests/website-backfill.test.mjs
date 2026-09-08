import assert from "node:assert/strict";
import test from "node:test";
import { harness, WORKSPACE } from "./sqlite-harness.mjs";

function seedWebsiteConnection(h) {
  h.sqlite.prepare(`INSERT INTO channel_connections
    (id,workspace_id,provider,role,display_name,status,publish_mode,created_at,updated_at)
    VALUES ('website-1',?,'website','both','tahashoes.vn','connected','api',?,?)`).run(WORKSPACE, Date.now(), Date.now());
}

async function seedReadyDraft(h, { productId = "product-1", id = "prepared-copy", provider = "facebook", status = "draft" } = {}) {
  const integrity = h.load("lib/product-integrity.ts");
  const { product, sku } = await integrity.productSources(productId, h.db);
  const platformData = { sku, sourceFingerprint: await integrity.productFingerprint(product),
    productDescription: "Mô tả website đã chuẩn bị", sourceImageCount: 1, generatedImageCount: 4 };
  const now = Date.now();
  h.sqlite.prepare(`INSERT INTO content_drafts
    (id,workspace_id,product_id,target_provider,content_type,title,body,hashtags_json,platform_data_json,status,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(id, WORKSPACE, productId, provider,
    provider === "website" ? "product_listing" : "social_post", "Giày PH0001", "Mô tả website đã chuẩn bị",
    JSON.stringify(["PH0001"]), JSON.stringify(platformData), status, now, now);
  return id;
}

function backfill(h, options = {}) {
  return h.load("lib/website-backfill.ts").ensureWebsiteReadyBackfill({ database: h.db, enabled: true, now: 1_800_000_000_000, ...options });
}

async function recordDelivery(h, now = 1_800_000_000_000) {
  await h.load("lib/scheduler.ts").runSchedulerTick({ database: h.db, now });
  h.sqlite.prepare(`UPDATE publish_jobs SET status='published',attempt_count=1,
    external_post_id='060971fef6313a99e31d99c2',external_url='https://tahashoes.vn/product/060971fef6313a99e31d99c2'
    WHERE connection_id='website-1' AND status='queued'`).run();
}

function seedPriorJob(h, status, code = null, attempts = 1) {
  const now = Date.now();
  h.sqlite.prepare(`INSERT INTO content_drafts
    (id,workspace_id,product_id,target_provider,content_type,body,status,created_at,updated_at)
    VALUES ('prior-website',?,'product-1','website','product_listing','Mô tả cũ','approved',?,?)`).run(WORKSPACE, now, now);
  h.sqlite.prepare(`INSERT INTO publish_jobs
    (id,workspace_id,connection_id,product_id,draft_id,job_kind,dedupe_key,status,scheduled_for,available_at,attempt_count,error_code,created_at,updated_at)
    VALUES ('prior-job',?,'website-1','product-1','prior-website','listing_upsert','prior-delivery',?,?,?,?,?,?,?)`)
    .run(WORKSPACE, status, now, now, attempts, code, now, now);
}

test("new catalog products publish immediately without a social draft or human approval", async () => {
  const h = harness();
  h.seedProduct();
  seedWebsiteConnection(h);
  const first = await backfill(h);
  assert.equal(first.queued, 1);
  const draft = h.sqlite.prepare("SELECT * FROM content_drafts WHERE target_provider='website'").get();
  assert.equal(draft.content_type, "product_listing");
  assert.equal(draft.status, "approved");
  assert.equal(draft.title, "Giày PH0001");
  assert.equal(draft.body, "Mô tả gốc PH0001");
  assert.equal(JSON.parse(draft.platform_data_json).generatedImageCount, 0);
  const schedule = h.sqlite.prepare("SELECT * FROM schedules WHERE draft_id=?").get(draft.id);
  assert.equal(schedule.run_at, 1_800_000_000_000);
  assert.equal(schedule.next_run_at, 1_800_000_000_000);
  assert.equal(schedule.execution_mode, "auto");
  assert.match(schedule.id, /^[A-Za-z0-9_-]{1,120}$/);
  assert.equal((await backfill(h)).queued, 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM schedules").get().n, 1);
  assert.equal(h.generated.length, 0);
});

test("prepared Facebook copy can feed website without approving Facebook or selecting generated images", async () => {
  const h = harness();
  h.seedProduct();
  seedWebsiteConnection(h);
  const sourceId = await seedReadyDraft(h);
  assert.equal((await backfill(h)).queued, 1);
  const draft = h.sqlite.prepare("SELECT * FROM content_drafts WHERE target_provider='website'").get();
  assert.equal(draft.body, "Mô tả website đã chuẩn bị");
  const data = JSON.parse(draft.platform_data_json);
  assert.equal(data.websiteSourceDraftId, sourceId);
  assert.equal(data.generatedImageCount, 0);
  assert.equal(data.sourceImageCount, 1);
  assert.equal(h.sqlite.prepare("SELECT status FROM content_drafts WHERE id=?").get(sourceId).status, "draft");
  assert.deepEqual(h.sqlite.prepare("SELECT media_id FROM content_draft_media WHERE draft_id=?").all(draft.id)
    .map((row) => row.media_id), ["image-product-1"]);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM schedules WHERE connection_id='facebook-1'").get().n, 0);
});

test("existing website review drafts do not block automatic publishing", async () => {
  const h = harness();
  h.seedProduct();
  seedWebsiteConnection(h);
  const sourceId = await seedReadyDraft(h, { provider: "website", status: "in_review" });
  assert.equal((await backfill(h)).queued, 1);
  assert.equal(h.sqlite.prepare("SELECT status FROM content_drafts WHERE generator='website-backfill'").get().status, "approved");
  assert.equal(h.sqlite.prepare("SELECT status FROM content_drafts WHERE id=?").get(sourceId).status, "in_review");
});

test("stale prepared copy falls back to current canonical catalog description", async () => {
  const h = harness();
  h.seedProduct();
  seedWebsiteConnection(h);
  await seedReadyDraft(h, { status: "approved" });
  h.sqlite.prepare("UPDATE products SET description='Mô tả sản phẩm mới' WHERE id='product-1'").run();
  assert.equal((await backfill(h)).queued, 1);
  const draft = h.sqlite.prepare("SELECT body,platform_data_json FROM content_drafts WHERE generator='website-backfill'").get();
  assert.equal(draft.body, "Mô tả sản phẩm mới");
  assert.equal(JSON.parse(draft.platform_data_json).websiteSourceDraftId, null);
});

test("catalog stock changes and reverts create one new upsert each after completed deliveries", async () => {
  const h = harness();
  h.seedProduct();
  seedWebsiteConnection(h);
  assert.equal((await backfill(h)).queued, 1);
  await recordDelivery(h);
  assert.equal((await backfill(h)).queued, 0);
  h.sqlite.prepare("UPDATE product_variants SET inventory_quantity=9 WHERE product_id='product-1'").run();
  assert.equal((await backfill(h, { now: 1_800_000_000_001 })).queued, 1);
  await recordDelivery(h, 1_800_000_000_001);
  h.sqlite.prepare("UPDATE product_variants SET inventory_quantity=10 WHERE product_id='product-1'").run();
  assert.equal((await backfill(h, { now: 1_800_000_000_002 })).queued, 1);
  await recordDelivery(h, 1_800_000_000_002);
  assert.equal((await backfill(h, { now: 1_800_000_000_003 })).queued, 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM publish_jobs WHERE connection_id='website-1'").get().n, 3);
});

test("all original Drive photos are retained, including large originals that the publisher compresses", async () => {
  const h = harness();
  h.seedProduct();
  seedWebsiteConnection(h);
  for (let index = 2; index <= 8; index += 1) {
    h.seedProduct(`temporary-${index}`, `PH00${index}`);
    h.sqlite.prepare("UPDATE product_media SET product_id='product-1' WHERE product_id=?").run(`temporary-${index}`);
    const metadata = { md5Checksum: `md5-${index}`, googleDriveSource: { connectionId: "google-1", driveFileId: `file-temporary-${index}`,
      driveFolderId: "folder-PH0001", skuKey: "PH0001", matchKind: "sku_folder" } };
    h.sqlite.prepare("UPDATE media_assets SET metadata_json=?,byte_size=900000 WHERE id=?")
      .run(JSON.stringify(metadata), `image-temporary-${index}`);
    h.sqlite.prepare("UPDATE products SET status='draft' WHERE id=?").run(`temporary-${index}`);
  }
  assert.equal((await backfill(h)).queued, 1);
  const draft = h.sqlite.prepare("SELECT id,platform_data_json FROM content_drafts WHERE generator='website-backfill'").get();
  assert.equal(JSON.parse(draft.platform_data_json).sourceImageCount, 8);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM content_draft_media WHERE draft_id=?").get(draft.id).n, 8);
});

test("ineligible catalog products are skipped without starving a later ready product", async () => {
  const h = harness();
  seedWebsiteConnection(h);
  for (let index = 0; index < 101; index += 1) h.seedProduct(`p-${String(index).padStart(3, "0")}`, `PH${String(index).padStart(4, "0")}`);
  h.sqlite.prepare("UPDATE product_variants SET price_minor=0 WHERE product_id!='p-100'").run();
  const result = await backfill(h, { limit: 1 });
  assert.equal(result.checked, 101);
  assert.equal(result.queued, 1);
  assert.equal(h.sqlite.prepare("SELECT product_id FROM content_drafts WHERE generator='website-backfill'").get().product_id, "p-100");
});

test("catalog integrity and required sizes remain mandatory", async () => {
  for (const fault of ["sku", "sizes", "source-images"]) {
    const h = harness();
    h.seedProduct();
    seedWebsiteConnection(h);
    if (fault === "sku") h.sqlite.prepare("UPDATE products SET base_sku='WRONG' WHERE id='product-1'").run();
    if (fault === "sizes") h.sqlite.prepare("UPDATE products SET metadata_json=json_set(metadata_json,'$.website.sizes',json('[]'))").run();
    if (fault === "source-images") h.sqlite.prepare("UPDATE media_assets SET origin='generated'").run();
    assert.equal((await backfill(h)).queued, 0, fault);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM schedules").get().n, 0, fault);
  }
});

test("in-flight and uncertain website deliveries are never replaced or requeued", async () => {
  for (const [status, code] of [["publishing", null], ["retry_wait", "WEBSITE_NETWORK_ERROR"], ["blocked", "DELIVERY_OUTCOME_UNKNOWN"], ["failed", "WEBSITE_NETWORK_ERROR"]]) {
    const h = harness();
    h.seedProduct();
    seedWebsiteConnection(h);
    seedPriorJob(h, status, code);
    assert.equal((await backfill(h)).queued, 0, status);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM publish_jobs").get().n, 1);
  }
});

test("a changed catalog revision supersedes a first-attempt preflight block without replaying the old job", async () => {
  const h = harness();
  h.seedProduct();
  seedWebsiteConnection(h);
  assert.equal((await backfill(h)).queued, 1);
  await h.load("lib/scheduler.ts").runSchedulerTick({ database: h.db, now: 1_800_000_000_000 });
  const original = h.sqlite.prepare("SELECT id,dedupe_key FROM publish_jobs").get();
  h.sqlite.prepare("UPDATE publish_jobs SET status='blocked',attempt_count=1,error_code='PRODUCT_CONTENT_STALE'").run();
  assert.equal((await backfill(h)).queued, 0, "same revision is not requeued");
  h.sqlite.prepare("UPDATE products SET description='Mô tả sản phẩm mới' WHERE id='product-1'").run();
  assert.equal((await backfill(h, { now: 1_800_000_000_001 })).queued, 1);
  await h.load("lib/scheduler.ts").runSchedulerTick({ database: h.db, now: 1_800_000_000_001 });
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM publish_jobs").get().n, 2);
  const prior = h.sqlite.prepare("SELECT status,dedupe_key FROM publish_jobs WHERE id=?").get(original.id);
  assert.equal(prior.status, "blocked");
  assert.equal(prior.dedupe_key, original.dedupe_key);
  assert.equal((await backfill(h)).queued, 0);
});

test("a preflight error after multiple attempts or a stored receipt cannot be presumed undelivered", async () => {
  for (const [attempts, receipt] of [[2, null], [1, "060971fef6313a99e31d99c2"]]) {
    const h = harness();
    h.seedProduct();
    seedWebsiteConnection(h);
    seedPriorJob(h, "blocked", "PRODUCT_CONTENT_STALE", attempts);
    if (receipt) h.sqlite.prepare("UPDATE publish_jobs SET external_post_id=?").run(receipt);
    h.sqlite.prepare("UPDATE products SET description='Mô tả sản phẩm mới' WHERE id='product-1'").run();
    assert.equal((await backfill(h)).queued, 0);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM publish_jobs").get().n, 1);
  }
});

test("a scheduler race cannot create a second delivery or orphaned automatic draft", async () => {
  const h = harness();
  h.seedProduct();
  seedWebsiteConnection(h);
  h.hooks.beforeBatch = () => seedPriorJob(h, "publishing");
  assert.equal((await backfill(h)).queued, 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM content_drafts WHERE generator='website-backfill'").get().n, 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM schedules").get().n, 0);
});

test("an existing future website schedule is superseded by an immediate automatic listing", async () => {
  const h = harness();
  h.seedProduct();
  seedWebsiteConnection(h);
  const prior = await seedReadyDraft(h, { provider: "website", status: "approved" });
  h.sqlite.prepare(`INSERT INTO schedules
    (id,workspace_id,draft_id,connection_id,status,schedule_kind,run_at,next_run_at,created_at,updated_at)
    VALUES ('old-future',?,?,'website-1','active','once',?,?,?,?)`)
    .run(WORKSPACE, prior, 1_900_000_000_000, 1_900_000_000_000, Date.now(), Date.now());
  assert.equal((await backfill(h)).queued, 1);
  assert.equal(h.sqlite.prepare("SELECT status FROM schedules WHERE id='old-future'").get().status, "paused");
  assert.equal(h.sqlite.prepare("SELECT next_run_at FROM schedules WHERE status='active'").get().next_run_at, 1_800_000_000_000);
  await recordDelivery(h);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM publish_jobs").get().n, 1);
});

test("does nothing while the website receiver flag is disabled", async () => {
  const h = harness();
  const result = await backfill(h, { enabled: false });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { enabled: false, checked: 0, queued: 0, skipped: 0, reason: "disabled" });
});
