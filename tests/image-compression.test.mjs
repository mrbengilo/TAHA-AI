import assert from "node:assert/strict";
import test from "node:test";
import { harness, ROOT, WORKSPACE } from "./sqlite-harness.mjs";
import path from "node:path";

function imageBinding(sizes, info = { format: "image/png", fileSize: 500_000, width: 1024, height: 1024 }) {
  const calls = [];
  return {
    calls,
    async info() { return info; },
    input() {
      return { transform(transform) { return { async output(options) {
        calls.push({ transform, options });
        const size = sizes.shift() ?? 400_000;
        return { image: () => new Blob([new Uint8Array(size)]).stream() };
      } }; } };
    },
  };
}

function addSourceImage(h, index, productId = "product-1", sku = "PH0001") {
  const id = `image-${productId}-extra-${index}`;
  const externalId = `file-${productId}-extra-${index}`;
  const metadata = { name: `${sku}-${index + 1}.jpg`, md5Checksum: `md5-extra-${index}`, googleDriveSource: {
    connectionId: "google-1", driveFileId: externalId, driveFolderId: `folder-${sku}`, skuKey: sku, matchKind: "sku_folder",
  } };
  h.sqlite.prepare(`INSERT INTO media_assets (id,workspace_id,source_connection_id,channel_id,media_type,origin,storage_provider,
    external_id,mime_type,byte_size,status,metadata_json,created_at,updated_at) VALUES (?,?,'google-1','google_drive','image',
    'source','google_drive',?,'image/jpeg',120000,'ready',?,?,?)`).run(id, WORKSPACE, externalId, JSON.stringify(metadata), Date.now(), Date.now());
  h.sqlite.prepare("INSERT INTO product_media (id,workspace_id,product_id,media_id,role,sort_order,created_at) VALUES (?,?,?,?,'gallery',?,?)")
    .run(`pm-${id}`, WORKSPACE, productId, id, index + 1, Date.now());
  return id;
}

test("generated image planning fills available post slots without exceeding six", () => {
  const h = harness();
  const compression = h.load("lib/image-compression.ts");
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((count) => compression.plannedGeneratedImageCount(count)), [4, 4, 3, 2, 1, 0, 0]);
});

test("bounded compressor checks actual bytes and advances through a finite fidelity ladder", async () => {
  const h = harness();
  const compression = h.load("lib/image-compression.ts");
  const binding = imageBinding([200_000, 199_999]);
  const result = await compression.compressImageToJpeg(new Blob([new Uint8Array(300_000)], { type: "image/png" }), 200_000, binding);
  assert.equal(result.blob.size, 199_999);
  assert.equal(binding.calls.length, 2);
  assert.equal(binding.calls[0].options.format, "image/jpeg");
  assert.equal(binding.calls[0].options.anim, false);
});

test("bounded compressor rejects decode bombs and fails closed when no candidate is below the ceiling", async () => {
  const h = harness();
  const compression = h.load("lib/image-compression.ts");
  await assert.rejects(compression.compressImageToJpeg(new Blob([new Uint8Array(10)]), 200_000,
    imageBinding([], { format: "image/png", fileSize: 10, width: 12_000, height: 12_000 })), /IMAGE_INPUT_INVALID/);
  const binding = imageBinding(Array(10).fill(200_000));
  await assert.rejects(compression.compressImageToJpeg(new Blob([new Uint8Array(10)]), 200_000, binding), /IMAGE_COMPRESSION_TARGET_UNREACHABLE/);
  assert.equal(binding.calls.length, 10);
});

test("Drive idempotency lookup rejects duplicate matching files", async () => {
  const h = harness();
  h.runtime.TEST_FETCH = async () => Response.json({ files: [
    { id: "one", name: "one.jpg", mimeType: "image/jpeg" },
    { id: "two", name: "two.jpg", mimeType: "image/jpeg" },
  ] });
  await assert.rejects(h.load("lib/integrations/google-drive.ts").findGoogleDriveFileByAppProperty("token", "folder", "tahaMediaId", "media"),
    (error) => error.code === "GOOGLE_DRIVE_IDEMPOTENCY_AMBIGUOUS");
});

test("optimized substitution rejects a raw Drive source replaced since catalog sync", async () => {
  const h = harness(); h.seedProduct();
  const derivedMetadata = {
    name: "PH0001-OPT-01.jpg",
    md5Checksum: "derived-md5",
    googleDriveSource: { connectionId: "google-1", driveFileId: "derived-file", driveFolderId: "folder-PH0001", skuKey: "PH0001" },
    optimization: { policy: "taha-jpeg-v1", sourceMediaId: "image-product-1", sourceExternalId: "file-product-1", sourceVersion: "md5-source" },
  };
  h.sqlite.prepare(`INSERT INTO media_assets (id,workspace_id,source_connection_id,channel_id,media_type,origin,storage_provider,
    external_id,mime_type,byte_size,status,metadata_json,created_at,updated_at) VALUES ('derived-1',?,'google-1','google_drive','image',
    'derived','google_drive','derived-file','image/jpeg',100000,'ready',?,?,?)`).run(WORKSPACE, JSON.stringify(derivedMetadata), Date.now(), Date.now());
  h.overrides.set(path.join(ROOT, "lib/integrations/connection-secrets.ts"), {
    getConnectedIntegration: async () => ({ id: "google-1" }), getGoogleAccessToken: async () => "token",
  });
  const urls = [];
  h.runtime.TEST_FETCH = async (url) => {
    urls.push(String(url));
    return Response.json({ id: "file-product-1", parents: ["folder-PH0001"], mimeType: "image/jpeg", md5Checksum: "replaced-md5" });
  };
  await assert.rejects(h.load("lib/media.ts").loadMedia("image-product-1"), /PRODUCT_MEDIA_MISMATCH/);
  assert.equal(urls.length, 1);
  assert.ok(!urls[0].includes("alt=media"));
});

test("generated gallery filters stale source versions before checking exact variants", async () => {
  const h = harness(); h.seedProduct();
  const integrity = h.load("lib/product-integrity.ts");
  const fingerprint = await integrity.productFingerprint((await integrity.productSources("product-1")).product);
  const variants = ["cycling", "running", "climbing", "stream"];
  const insert = (id, variant, version) => {
    const externalId = `file-${id}`;
    const metadata = { googleDriveSource: { connectionId: "google-1", driveFileId: externalId, driveFolderId: "folder-PH0001", skuKey: "PH0001" }, generation: {
      variant, sourceMediaId: "image-product-1", sourceExternalId: "file-product-1", sourceVersion: version,
      sourceFingerprint: fingerprint, promptVersion: "taha-lifestyle-v3", compressionPolicy: "taha-jpeg-v1",
    } };
    h.sqlite.prepare(`INSERT INTO media_assets (id,workspace_id,source_connection_id,channel_id,media_type,origin,storage_provider,
      external_id,mime_type,byte_size,status,metadata_json,created_at,updated_at) VALUES (?,?,'google-1','google_drive','image','generated',
      'google_drive',?,'image/jpeg',150000,'ready',?,?,?)`).run(id, WORKSPACE, externalId, JSON.stringify(metadata), Date.now(), Date.now());
    h.sqlite.prepare("INSERT INTO product_media (id,workspace_id,product_id,media_id,role,created_at) VALUES (?,?, 'product-1',?,'generated',?)")
      .run(`pm-${id}`, WORKSPACE, id, Date.now());
  };
  insert("stale-cycling", "cycling", "old-md5");
  for (const variant of variants) insert(`current-${variant}`, variant, "md5-source");
  const verified = await integrity.verifiedProductGeneratedImages("product-1");
  assert.deepEqual(Array.from(verified, (row) => row.id), variants.map((variant) => `current-${variant}`));
  await assert.rejects(integrity.assertGeneratedProductMedia("product-1",
    ["stale-cycling", "current-running", "current-climbing", "current-stream"], fingerprint,
    "taha-lifestyle-v3", variants), /PRODUCT_GENERATED_MEDIA_MISMATCH/);
});

test("source normalization creates one canonical derivative and reuses it on replay", async () => {
  const h = harness(); h.seedProduct();
  h.overrides.delete(path.join(ROOT, "lib/product-image-processing.ts"));
  h.sqlite.prepare("UPDATE media_assets SET byte_size=400000 WHERE id='image-product-1'").run();
  h.sqlite.prepare("UPDATE channel_connections SET scopes_json=? WHERE id='google-1'")
    .run(JSON.stringify(["https://www.googleapis.com/auth/drive"]));
  h.overrides.set(path.join(ROOT, "lib/integrations/connection-secrets.ts"), {
    getConnectedIntegration: async () => ({ id: "google-1" }), getGoogleAccessToken: async () => "token",
  });
  h.runtime.IMAGES = imageBinding([150_000]);
  let saved = null;
  let uploads = 0;
  h.runtime.TEST_FETCH = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/drive/v3/files" && url.searchParams.has("q")) return Response.json({ files: saved ? [saved] : [] });
    if (url.pathname.endsWith("/file-product-1") && url.searchParams.get("alt") !== "media") {
      return Response.json({ id: "file-product-1", name: "PH0001.jpg", mimeType: "image/jpeg", size: "400000", md5Checksum: "md5-source", parents: ["folder-PH0001"] });
    }
    if (url.pathname.endsWith("/file-product-1") && url.searchParams.get("alt") === "media") {
      return new Response(new Uint8Array(400_000), { headers: { "content-type": "image/jpeg", "content-length": "400000" } });
    }
    if (url.pathname === "/upload/drive/v3/files") {
      uploads += 1;
      const text = await new Response(init.body).text();
      const mediaId = /"tahaMediaId":"([^"]+)"/.exec(text)?.[1];
      assert.ok(mediaId);
      saved = { id: "derived-file", name: "PH0001-OPT-01.jpg", mimeType: "image/jpeg", size: "150000", md5Checksum: "derived-md5",
        modifiedTime: "now", parents: ["folder-PH0001"], appProperties: { tahaMediaId: mediaId, tahaProductId: "product-1", tahaSku: "PH0001", tahaKind: "optimized" } };
      return Response.json(saved);
    }
    if (url.pathname.endsWith("/derived-file") && url.searchParams.get("alt") !== "media") return Response.json(saved);
    if (url.pathname.endsWith("/derived-file") && url.searchParams.get("alt") === "media") {
      return new Response(new Uint8Array(150_000), { headers: { "content-type": "image/jpeg", "content-length": "150000" } });
    }
    throw new Error(`Unexpected Drive request: ${url}`);
  };
  const processing = h.load("lib/product-image-processing.ts");
  const first = await processing.normalizeProductSourceImages("product-1");
  const second = await processing.normalizeProductSourceImages("product-1");
  assert.equal(first.created, 1);
  assert.equal(second.reused, 1);
  assert.equal(uploads, 1);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM media_assets WHERE origin='derived'").get().n, 1);
  const optimized = await h.load("lib/media.ts").mediaBlob("image-product-1", 300_000);
  assert.equal(optimized.blob.size, 150_000);
});

test("source normalization repairs stale byte metadata after a live Drive check", async () => {
  const h = harness(); h.seedProduct();
  h.overrides.delete(path.join(ROOT, "lib/product-image-processing.ts"));
  h.sqlite.prepare("UPDATE media_assets SET byte_size=NULL, mime_type='image/png' WHERE id='image-product-1'").run();
  h.sqlite.prepare("UPDATE channel_connections SET scopes_json=? WHERE id='google-1'")
    .run(JSON.stringify(["https://www.googleapis.com/auth/drive"]));
  h.overrides.set(path.join(ROOT, "lib/integrations/connection-secrets.ts"), {
    getConnectedIntegration: async () => ({ id: "google-1" }), getGoogleAccessToken: async () => "token",
  });
  let requests = 0;
  h.runtime.TEST_FETCH = async (input) => {
    const url = new URL(input);
    requests += 1;
    assert.ok(url.pathname.endsWith("/file-product-1"));
    assert.notEqual(url.searchParams.get("alt"), "media");
    return Response.json({ id: "file-product-1", name: "PH0001.jpg", mimeType: "image/jpeg", size: "120000",
      md5Checksum: "md5-source", parents: ["folder-PH0001"] });
  };
  const result = await h.load("lib/product-image-processing.ts").normalizeProductSourceImages("product-1");
  assert.deepEqual({ checked: result.checked, alreadyWithinLimit: result.alreadyWithinLimit, created: result.created },
    { checked: 1, alreadyWithinLimit: 1, created: 0 });
  assert.equal(requests, 1);
  const repaired = h.sqlite.prepare("SELECT byte_size, mime_type FROM media_assets WHERE id='image-product-1'").get();
  assert.equal(repaired.byte_size, 120000);
  assert.equal(repaired.mime_type, "image/jpeg");
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM media_assets WHERE origin='derived'").get().n, 0);
});

test("prepare-only creates an unscheduled four-image draft and confirmation reuses its media", async () => {
  const h = harness(); h.seedProduct();
  const extraMetadata = { name: "PH0001-02.jpg", md5Checksum: "md5-extra", googleDriveSource: {
    connectionId: "google-1", driveFileId: "file-product-1-extra", driveFolderId: "folder-PH0001", skuKey: "PH0001", matchKind: "sku_folder",
  } };
  h.sqlite.prepare(`INSERT INTO media_assets (id,workspace_id,source_connection_id,channel_id,media_type,origin,storage_provider,
    external_id,mime_type,byte_size,status,metadata_json,created_at,updated_at) VALUES ('image-product-1-extra',?,'google-1','google_drive',
    'image','source','google_drive','file-product-1-extra','image/jpeg',120000,'ready',?,?,?)`)
    .run(WORKSPACE, JSON.stringify(extraMetadata), Date.now(), Date.now());
  h.sqlite.prepare("INSERT INTO product_media (id,workspace_id,product_id,media_id,role,sort_order,created_at) VALUES ('pm-product-1-extra',?,'product-1','image-product-1-extra','gallery',1,?)")
    .run(WORKSPACE, Date.now());
  h.overrides.set(path.join(ROOT, "lib/integrations/facebook-permissions.ts"), { verifyFacebookConnection: async () => ({ ready: true }) });
  h.sqlite.prepare("UPDATE channel_connections SET status='expired' WHERE provider='facebook'").run();
  const edits = [];
  h.overrides.set(path.join(ROOT, "lib/ai/openai.ts"), {
    async generateProductContent(input) {
      return { model: "text-model", content: { productDescription: `Mô tả ${input.product.sku}`, hashtags: ["#TAHA"], channels: { facebook: { title: "Giày", body: "Bài viết PH0001", hashtags: ["#TAHA"] } } } };
    },
    async editProductImage(input) {
      edits.push(input.layoutIndex);
      return { model: "image-model", image: new Blob([new Uint8Array(250_000)], { type: "image/png" }), mimeType: "image/png" };
    },
  });
  h.runtime.IMAGES = imageBinding(Array(20).fill(150_000));
  h.overrides.set(path.join(ROOT, "lib/media.ts"), {
    mediaBlob: async () => ({ blob: new Blob([new Uint8Array(250_000)], { type: "image/jpeg" }), mimeType: "image/jpeg", filename: "PH0001.jpg" }),
  });
  const variants = ["cycling", "running", "climbing", "stream"];
  const normalized = [];
  h.overrides.set(path.join(ROOT, "lib/product-image-processing.ts"), {
    LIFESTYLE_VARIANTS: variants,
    normalizeProductSourceImages: async (_productId, ids) => { normalized.push(...ids); return { checked: ids.length }; },
    async findOrPersistGeneratedImage(input) {
      const id = `generated-${input.variant}`;
      if (!input.blob && !h.sqlite.prepare("SELECT id FROM media_assets WHERE id=?").get(id)) return null;
      if (!h.sqlite.prepare("SELECT id FROM media_assets WHERE id=?").get(id)) {
        const metadata = { googleDriveSource: { connectionId: "google-1", driveFileId: `file-${id}`, driveFolderId: "folder-PH0001", skuKey: "PH0001" }, generation: {
          variant: input.variant, sourceMediaId: input.source.id, sourceExternalId: input.source.external_id,
          sourceVersion: "md5-source", sourceFingerprint: input.sourceFingerprint, promptVersion: input.promptVersion,
          compressionPolicy: "taha-jpeg-v1",
        } };
        h.sqlite.prepare(`INSERT INTO media_assets (id,workspace_id,source_connection_id,channel_id,media_type,origin,storage_provider,
          external_id,mime_type,byte_size,status,metadata_json,created_at,updated_at) VALUES (?,?,'google-1','google_drive','image','generated',
          'google_drive',?,'image/jpeg',150000,'ready',?,?,?)`).run(id, WORKSPACE, `file-${id}`, JSON.stringify(metadata), Date.now(), Date.now());
        h.sqlite.prepare("INSERT INTO product_media (id,workspace_id,product_id,media_id,role,created_at) VALUES (?,?,?,?,'generated',?)")
          .run(`pm-${id}`, WORKSPACE, input.productId, id, Date.now());
      }
      return { mediaId: id, byteSize: 150_000 };
    },
  });
  const automation = h.load("lib/automation.ts");
  const first = await automation.queueAutomationRun({ productId: "product-1", targetProviders: ["facebook"], idempotencyKey: "prepare-product-1-v1", prepareOnly: true });
  assert.equal(first.run.requestedImageCount, 4);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM automation_steps WHERE step_type='image'").get().n, 4);
  for (let tick = 0; tick < 8; tick += 1) await automation.runAutomationWorker();
  assert.deepEqual(edits, [1, 2, 3, 4]);
  assert.deepEqual(normalized, ["image-product-1", "image-product-1-extra"]);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM automation_steps WHERE step_type='optimize' AND status='completed'").get().n, 2);
  assert.deepEqual(h.sqlite.prepare("SELECT status FROM content_drafts").all().map((row) => row.status), ["draft"]);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM schedules").get().n, 0);
  assert.deepEqual(JSON.parse(h.sqlite.prepare("SELECT output_media_ids_json value FROM automation_runs").get().value), variants.map((variant) => `generated-${variant}`));
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM content_draft_media").get().n, 6);

  h.sqlite.prepare("UPDATE channel_connections SET status='connected' WHERE provider='facebook'").run();
  await automation.queueAutomationRun({ productId: "product-1", targetProviders: ["facebook"], idempotencyKey: "confirm-product-1-v2" });
  for (let tick = 0; tick < 8; tick += 1) await automation.runAutomationWorker();
  assert.deepEqual(edits, [1, 2, 3, 4]);
  assert.deepEqual(normalized, ["image-product-1", "image-product-1-extra", "image-product-1", "image-product-1-extra"]);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM media_assets WHERE origin='generated'").get().n, 4);
  assert.deepEqual(h.sqlite.prepare("SELECT status FROM content_drafts ORDER BY created_at,id").all().map((row) => row.status), ["draft", "approved"]);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM schedules WHERE status='active'").get().n, 1);
});

test("six source images skip image generation and still create a six-image draft", async () => {
  const h = harness(); h.seedProduct();
  for (let index = 0; index < 5; index += 1) addSourceImage(h, index);
  h.overrides.set(path.join(ROOT, "lib/ai/openai.ts"), {
    async generateProductContent() {
      return { model: "text-model", content: { productDescription: "Mô tả PH0001", hashtags: ["#TAHA"],
        channels: { facebook: { title: "Giày", body: "Bài viết PH0001", hashtags: ["#TAHA"] } } } };
    },
    async editProductImage() { throw new Error("IMAGE_GENERATION_MUST_BE_SKIPPED"); },
  });
  const normalized = [];
  h.overrides.set(path.join(ROOT, "lib/product-image-processing.ts"), {
    LIFESTYLE_VARIANTS: ["cycling", "running", "climbing", "stream"],
    normalizeProductSourceImages: async (_productId, ids) => { normalized.push(...ids); return { checked: ids.length }; },
    async findOrPersistGeneratedImage() { throw new Error("IMAGE_GENERATION_MUST_BE_SKIPPED"); },
  });
  const automation = h.load("lib/automation.ts");
  const queued = await automation.queueAutomationRun({ productId: "product-1", targetProviders: ["facebook"],
    idempotencyKey: "six-source-prepare", prepareOnly: true, imageCount: 4 });
  assert.equal(queued.run.requestedImageCount, 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM automation_steps WHERE step_type='image'").get().n, 0);
  for (let tick = 0; tick < 9; tick += 1) await automation.runAutomationWorker({ limit: 1 });
  assert.equal(normalized.length, 6);
  assert.equal(h.sqlite.prepare("SELECT status FROM automation_runs").get().status, "completed");
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM content_drafts WHERE status='draft'").get().n, 1);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM content_draft_media").get().n, 6);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM media_assets WHERE origin='generated'").get().n, 0);
});

test("retry replans an older failed run after the SKU reaches six source images", async () => {
  const h = harness(); h.seedProduct();
  const automation = h.load("lib/automation.ts");
  const queued = await automation.queueAutomationRun({ productId: "product-1", targetProviders: ["facebook"],
    idempotencyKey: "old-four-image-run", prepareOnly: true, imageCount: 4 });
  assert.equal(queued.run.requestedImageCount, 4);
  h.sqlite.prepare("UPDATE automation_runs SET status='failed', error_code='OPENAI_RATE_LIMITED'").run();
  h.sqlite.prepare("UPDATE automation_steps SET status='cancelled'").run();
  for (let index = 0; index < 5; index += 1) addSourceImage(h, index);
  const retried = await automation.retryAutomationRun(queued.run.id);
  assert.equal(retried.requestedImageCount, 0);
  assert.equal(h.sqlite.prepare("SELECT requested_image_count n FROM automation_runs").get().n, 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM automation_steps WHERE step_type='image'").get().n, 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM automation_steps WHERE step_type IN ('content','finalize') AND status='queued'").get().n, 2);
});

test("a source added after the durable optimization snapshot blocks generation and finalization", async () => {
  const h = harness(); h.seedProduct();
  const automation = h.load("lib/automation.ts");
  await automation.queueAutomationRun({ productId: "product-1", targetProviders: ["facebook"], idempotencyKey: "prepare-source-race", prepareOnly: true });
  assert.equal((await automation.runAutomationWorker()).completed, 1);
  assert.equal((await automation.runAutomationWorker()).completed, 1);
  const metadata = { name: "PH0001-new.jpg", md5Checksum: "new-md5", googleDriveSource: {
    connectionId: "google-1", driveFileId: "new-file", driveFolderId: "folder-PH0001", skuKey: "PH0001", matchKind: "sku_folder",
  } };
  h.sqlite.prepare(`INSERT INTO media_assets (id,workspace_id,source_connection_id,channel_id,media_type,origin,storage_provider,
    external_id,mime_type,byte_size,status,metadata_json,created_at,updated_at) VALUES ('new-source',?,'google-1','google_drive','image',
    'source','google_drive','new-file','image/jpeg',120000,'ready',?,?,?)`).run(WORKSPACE, JSON.stringify(metadata), Date.now(), Date.now());
  h.sqlite.prepare("INSERT INTO product_media (id,workspace_id,product_id,media_id,role,sort_order,created_at) VALUES ('pm-new-source',?,'product-1','new-source','gallery',2,?)")
    .run(WORKSPACE, Date.now());
  const blocked = await automation.runAutomationWorker();
  assert.equal(blocked.retrying, 1);
  assert.equal(blocked.errors[0].code, "PRODUCT_MEDIA_MISMATCH");
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM media_assets WHERE origin='generated'").get().n, 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM content_drafts").get().n, 0);
});

test("an older ready SKU finalizes before a newer SKU's queued image work", async () => {
  const h = harness();
  h.seedProduct("product-pilot", "PH0014");
  const automation = h.load("lib/automation.ts");
  const pilot = await automation.queueAutomationRun({ productId: "product-pilot", targetProviders: ["facebook"],
    idempotencyKey: "prepare-pilot-first", prepareOnly: true, imageCount: 0 });
  assert.equal((await automation.runAutomationWorker({ limit: 1 })).completed, 1);
  assert.equal((await automation.runAutomationWorker({ limit: 1 })).completed, 1);

  h.seedProduct("product-later", "PH0099");
  const later = await automation.queueAutomationRun({ productId: "product-later", targetProviders: ["facebook"],
    idempotencyKey: "prepare-later", prepareOnly: true });
  h.sqlite.prepare("UPDATE automation_runs SET created_at=1 WHERE id=?").run(pilot.run.id);
  h.sqlite.prepare("UPDATE automation_runs SET created_at=2, status='processing' WHERE id=?").run(later.run.id);
  h.sqlite.prepare("UPDATE automation_steps SET status='completed' WHERE run_id=? AND step_type='content'").run(later.run.id);

  const result = await automation.runAutomationWorker({ limit: 1 });
  assert.equal(result.completed, 1, JSON.stringify(result));
  assert.equal(h.sqlite.prepare("SELECT status FROM automation_runs WHERE id=?").get(pilot.run.id).status, "completed");
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM automation_steps WHERE run_id=? AND step_type='image' AND status='queued'")
    .get(later.run.id).n, 4);
});

test("a run filter never leases an earlier unrelated publish-capable run", async () => {
  const h = harness();
  h.overrides.set(path.join(ROOT, "lib/integrations/facebook-permissions.ts"), { verifyFacebookConnection: async () => ({ ready: true }) });
  h.seedProduct("product-unrelated", "PH0001");
  const automation = h.load("lib/automation.ts");
  const unrelated = await automation.queueAutomationRun({ productId: "product-unrelated", targetProviders: ["facebook"],
    idempotencyKey: "publish-unrelated", imageCount: 0 });
  h.seedProduct("product-catalog", "PH0014");
  const catalog = await automation.queueAutomationRun({ productId: "product-catalog", targetProviders: ["facebook"],
    idempotencyKey: "prepare-catalog-filtered", prepareOnly: true, imageCount: 0 });
  h.sqlite.prepare("UPDATE automation_runs SET created_at=1 WHERE id=?").run(unrelated.run.id);
  h.sqlite.prepare("UPDATE automation_runs SET created_at=2 WHERE id=?").run(catalog.run.id);
  h.sqlite.prepare("UPDATE automation_runs SET status='processing' WHERE id=?").run(unrelated.run.id);
  h.sqlite.prepare("UPDATE automation_steps SET status='processing', lease_owner='unrelated-worker', lease_expires_at=0 WHERE run_id=? AND step_type='content'")
    .run(unrelated.run.id);

  const result = await automation.runAutomationWorker({ limit: 1, runIds: [catalog.run.id] });
  assert.equal(result.completed, 1, JSON.stringify(result));
  assert.equal(h.sqlite.prepare("SELECT status FROM automation_steps WHERE run_id=? AND step_type='content'")
    .get(catalog.run.id).status, "completed");
  assert.equal(h.sqlite.prepare("SELECT status FROM automation_steps WHERE run_id=? AND step_type='content'")
    .get(unrelated.run.id).status, "processing");
  await assert.rejects(automation.runAutomationWorker({ runIds: ["not-a-run-id"] }), /AUTOMATION_RUN_FILTER_INVALID/);
});
