import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { harness, ROOT, WORKSPACE } from "./sqlite-harness.mjs";

function realTemplateHarness() {
  const h = harness();
  h.overrides.delete(path.join(ROOT, "lib/ai/template.ts"));
  return h;
}

async function seedCanonicalDraft(h) {
  h.seedProduct();
  const automation = h.load("lib/automation.ts");
  const queued = await automation.queueAutomationRun({
    productId: "product-1",
    targetProviders: ["facebook"],
    idempotencyKey: "post-template-seed-product-1",
    imageCount: 0,
    prepareOnly: true,
  });
  for (let tick = 0; tick < 3; tick += 1) {
    const result = await automation.runAutomationWorker();
    assert.equal(result.completed, 1, JSON.stringify(result));
  }
  const article = h.sqlite.prepare("SELECT * FROM product_articles WHERE product_id='product-1'").get();
  const draft = h.sqlite.prepare("SELECT * FROM content_drafts WHERE product_id='product-1'").get();
  assert.ok(article);
  assert.ok(draft);
  return { article, draft, run: queued.run };
}

function insertJob(h, draft, status, id, extra = {}) {
  const now = Date.now();
  h.sqlite.prepare(`INSERT INTO publish_jobs
    (id,workspace_id,connection_id,product_id,draft_id,job_kind,dedupe_key,status,scheduled_for,available_at,
     payload_snapshot_json,external_post_id,created_at,updated_at)
    VALUES (?,?,'facebook-1','product-1',?,'social_post',?,?,?,?,?,?,?,?)`)
    .run(
      id,
      WORKSPACE,
      draft.id,
      `dedupe-${id}`,
      status,
      now + 60_000,
      now,
      JSON.stringify({
        title: "Tiêu đề cũ",
        message: "Nội dung cũ",
        hashtags: ["#OLD"],
        draftVersion: draft.version,
        platformData: {},
      }),
      extra.externalPostId ?? null,
      now,
      now,
    );
  if (extra.errorCode) {
    h.sqlite.prepare("UPDATE publish_jobs SET error_code=?,error_message=? WHERE id=?")
      .run(extra.errorCode, "Nội dung đã cũ", id);
  }
}

test("default post template exposes all eight editable sections and renders verified product facts", async () => {
  const h = realTemplateHarness();
  const service = h.load("lib/post-template.ts");
  const template = await service.getPostTemplate();

  assert.equal(template.version, 0);
  assert.equal(template.isDefault, true);
  assert.deepEqual(Array.from(template.config.sections, (section) => section.key), [
    "product_name", "sku", "sizes", "description", "gifts", "warranty", "contact", "hashtags",
  ]);
  assert.ok(template.config.sections.every((section) => section.enabled));

  const generated = await h.load("lib/ai/template.ts").generateProductContent({
    product: {
      sku: "PH0006",
      name: "Lituo Sport PH0006 - Bảo hành 12 tháng - Quà tặng khử mùi & vớ thể thao",
      description: "Sneaker thể thao dễ phối",
      brand: "Lituo Sport",
      category: "Sneaker",
      sizes: ["36", "37", "38"],
    },
    targetProviders: ["facebook"],
  });
  const article = generated.content.canonicalArticle;
  assert.match(article.body, /Mã sản phẩm: PH0006/u);
  assert.match(article.body, /Size hiện có: 36, 37, 38/u);
  assert.match(article.body, /Quà tặng kèm: khử mùi \+ vớ thể thao/u);
  assert.match(article.body, /Bảo hành 12 tháng/u);
  assert.match(article.body, /THÔNG TIN LIÊN HỆ/u);
  assert.match(article.body, /#TAHAShoes[\s\S]*#PH0006/u);
  assert.deepEqual(Array.from(article.hashtags), []);
});

test("saving a new structure atomically refreshes articles, drafts and safe pending jobs without changing published delivery", async () => {
  const h = realTemplateHarness();
  const seeded = await seedCanonicalDraft(h);
  insertJob(h, seeded.draft, "queued", "job-queued");
  insertJob(h, seeded.draft, "blocked", "job-stale", { errorCode: "PRODUCT_CONTENT_STALE" });
  insertJob(h, seeded.draft, "publishing", "job-publishing");
  insertJob(h, seeded.draft, "published", "job-published", { externalPostId: "facebook-post-1" });

  const templates = h.load("lib/post-template.ts");
  const updater = h.load("lib/post-template-refresh.ts");
  const current = await templates.getPostTemplate();
  const config = structuredClone(current.config);
  config.name = "Bài viết mới do admin quản lý";
  config.titleTemplate = "{{sku}} | {{product_name}}";
  config.introText = "NỘI DUNG THEO CẤU TRÚC MỚI";
  config.sections.find((section) => section.key === "gifts").enabled = false;
  config.sections.find((section) => section.key === "contact").enabled = false;
  const hashtags = config.sections.find((section) => section.key === "hashtags");
  config.sections = [hashtags, ...config.sections.filter((section) => section.key !== "hashtags")];

  const result = await updater.updatePostTemplate({ expectedVersion: 0, config }, "admin-test", h.db);
  assert.equal(result.changed, true);
  assert.equal(result.template.version, 1);
  assert.equal(result.refresh.articles, 1);
  assert.equal(result.refresh.drafts, 1);
  assert.equal(result.refresh.jobs, 2);
  assert.equal(result.refresh.staleJobsRequeued, 1);
  assert.equal(result.refresh.publishingJobsSkipped, 1);

  const article = h.sqlite.prepare("SELECT * FROM product_articles WHERE product_id='product-1'").get();
  const draft = h.sqlite.prepare("SELECT * FROM content_drafts WHERE id=?").get(seeded.draft.id);
  assert.match(article.body, /^NỘI DUNG THEO CẤU TRÚC MỚI/u);
  assert.ok(article.body.indexOf("#TAHAShoes") < article.body.indexOf("Mã sản phẩm: PH0001"));
  assert.doesNotMatch(article.body, /MUA SẮM CÙNG TAHA SHOES/u);
  assert.equal(draft.body, article.body);
  assert.equal(draft.version, seeded.draft.version + 1);
  assert.equal(JSON.parse(draft.platform_data_json).postTemplateVersion, 1);

  const queued = h.sqlite.prepare("SELECT * FROM publish_jobs WHERE id='job-queued'").get();
  const stale = h.sqlite.prepare("SELECT * FROM publish_jobs WHERE id='job-stale'").get();
  const publishing = h.sqlite.prepare("SELECT * FROM publish_jobs WHERE id='job-publishing'").get();
  const published = h.sqlite.prepare("SELECT * FROM publish_jobs WHERE id='job-published'").get();
  assert.equal(JSON.parse(queued.payload_snapshot_json).message, article.body);
  assert.equal(JSON.parse(stale.payload_snapshot_json).message, article.body);
  assert.equal(stale.status, "queued");
  assert.equal(stale.error_code, null);
  assert.equal(JSON.parse(publishing.payload_snapshot_json).message, "Nội dung cũ");
  assert.equal(JSON.parse(published.payload_snapshot_json).message, "Nội dung cũ");
  assert.equal(published.external_post_id, "facebook-post-1");

  h.seedProduct("product-2", "PH0007");
  const future = await h.load("lib/ai/template.ts").generateProductContent({
    product: { sku: "PH0007", name: "Lituo PH0007", sizes: ["39", "40"] },
    targetProviders: ["facebook"],
  });
  assert.match(future.content.canonicalArticle.body, /^NỘI DUNG THEO CẤU TRÚC MỚI/u);
  assert.ok(future.content.canonicalArticle.body.indexOf("#TAHAShoes") < future.content.canonicalArticle.body.indexOf("Mã sản phẩm: PH0007"));
});

test("post template updates reject stale admin versions and invalid cross-section placeholders", async () => {
  const h = realTemplateHarness();
  const templates = h.load("lib/post-template.ts");
  const updater = h.load("lib/post-template-refresh.ts");
  const current = await templates.getPostTemplate();
  const first = structuredClone(current.config);
  first.introText = "Phiên bản một";
  await updater.updatePostTemplate({ expectedVersion: 0, config: first }, "admin-a", h.db);

  const stale = structuredClone(first);
  stale.introText = "Ghi đè từ phiên cũ";
  await assert.rejects(
    updater.updatePostTemplate({ expectedVersion: 0, config: stale }, "admin-b", h.db),
    (error) => error.code === "POST_TEMPLATE_VERSION_CONFLICT",
  );

  const latest = await templates.getPostTemplate();
  const invalid = structuredClone(latest.config);
  invalid.sections[0].template = "{{product_name}} {{sku}}";
  await assert.rejects(
    updater.updatePostTemplate({ expectedVersion: latest.version, config: invalid }, "admin-c", h.db),
    (error) => error.code === "POST_TEMPLATE_INVALID",
  );
  assert.equal((await templates.getPostTemplate()).version, 1);
});

test("concurrent saves of the same revision apply exactly once", async () => {
  const h = realTemplateHarness();
  await seedCanonicalDraft(h);
  const templates = h.load("lib/post-template.ts");
  const updater = h.load("lib/post-template-refresh.ts");
  const current = await templates.getPostTemplate();
  const first = structuredClone(current.config);
  const second = structuredClone(current.config);
  first.introText = "Cấu trúc cạnh tranh";
  second.introText = "Cấu trúc cạnh tranh";
  const beforeDraftVersion = h.sqlite.prepare("SELECT version FROM content_drafts WHERE product_id='product-1'").get().version;

  const outcomes = await Promise.allSettled([
    updater.updatePostTemplate({ expectedVersion: current.version, config: first }, "admin-concurrent", h.db),
    updater.updatePostTemplate({ expectedVersion: current.version, config: second }, "admin-concurrent", h.db),
  ]);

  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = outcomes.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "POST_TEMPLATE_VERSION_CONFLICT");
  assert.equal(
    h.sqlite.prepare("SELECT version FROM content_drafts WHERE product_id='product-1'").get().version,
    beforeDraftVersion + 1,
  );
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS total FROM audit_logs WHERE action='POST_TEMPLATE_UPDATED'").get().total, 1);
});
