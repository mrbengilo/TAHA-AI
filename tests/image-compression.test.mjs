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

test("sourcePhotoBlob compresses a large Drive original below 300 KB and rejects generated media", async () => {
  const h = harness(); h.seedProduct();
  h.sqlite.prepare("UPDATE media_assets SET byte_size=400000, mime_type='image/png' WHERE id='image-product-1'").run();
  h.overrides.set(path.join(ROOT, "lib/integrations/connection-secrets.ts"), {
    getConnectedIntegration: async () => ({ id: "google-1" }), getGoogleAccessToken: async () => "token",
  });
  h.runtime.IMAGES = imageBinding([299_999]);
  h.runtime.TEST_FETCH = async (input) => {
    const url = new URL(input);
    if (url.searchParams.get("alt") === "media") {
      return new Response(new Uint8Array(400_000), { headers: { "content-type": "image/png", "content-length": "400000" } });
    }
    return Response.json({ id: "file-product-1", name: "PH0001.png", mimeType: "image/png", size: "400000",
      md5Checksum: "md5-source", parents: ["folder-PH0001"] });
  };
  const media = h.load("lib/media.ts");
  const photo = await media.sourcePhotoBlob("image-product-1");
  assert.equal(photo.mimeType, "image/jpeg");
  assert.equal(photo.blob.size, 299_999);
  h.sqlite.prepare("UPDATE media_assets SET origin='generated' WHERE id='image-product-1'").run();
  await assert.rejects(media.sourcePhotoBlob("image-product-1"), /PRODUCT_MEDIA_MISMATCH/);
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

test("automation publishes every original source image with no six-image cap", async () => {
  const h = harness(); h.seedProduct();
  for (let index = 0; index < 8; index += 1) addSourceImage(h, index);
  h.overrides.set(path.join(ROOT, "lib/ai/openai.ts"), {
    async generateProductContent() {
      return { model: "text-model", content: { productDescription: "Mô tả PH0001", hashtags: ["#TAHA"],
        channels: { facebook: { title: "Giày", body: "Bài viết PH0001", hashtags: ["#TAHA"] } } } };
    },
  });
  const normalized = [];
  h.overrides.set(path.join(ROOT, "lib/product-image-processing.ts"), {
    normalizeProductSourceImages: async (_productId, ids) => { normalized.push(...ids); return { checked: ids.length }; },
  });
  const automation = h.load("lib/automation.ts");
  const queued = await automation.queueAutomationRun({ productId: "product-1", targetProviders: ["facebook"],
    idempotencyKey: "all-source-prepare", prepareOnly: true });
  assert.equal(queued.run.requestedImageCount, 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM automation_steps WHERE step_type='image'").get().n, 0);
  for (let tick = 0; tick < 12; tick += 1) await automation.runAutomationWorker({ limit: 1 });
  assert.equal(normalized.length, 9);
  assert.equal(h.sqlite.prepare("SELECT status FROM automation_runs").get().status, "completed");
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM content_drafts WHERE status='draft'").get().n, 1);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM content_draft_media").get().n, 9);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM media_assets WHERE origin='generated'").get().n, 0);
});

test("retry permanently removes legacy queued image-generation work", async () => {
  const h = harness(); h.seedProduct();
  const automation = h.load("lib/automation.ts");
  const queued = await automation.queueAutomationRun({ productId: "product-1", targetProviders: ["facebook"],
    idempotencyKey: "old-image-run", prepareOnly: true });
  assert.equal(queued.run.requestedImageCount, 0);
  h.sqlite.prepare("UPDATE automation_runs SET status='failed', requested_image_count=4, prompt_version='taha-lifestyle-v3', error_code='OPENAI_RATE_LIMITED'").run();
  h.sqlite.prepare(`INSERT INTO automation_steps
    (id,workspace_id,run_id,step_type,ordinal,status,available_at,attempt_count,max_attempts,result_json,created_at,updated_at)
    VALUES ('legacy-image-step',?,?, 'image',0,'queued',0,0,3,'{}',0,0)`).run(WORKSPACE, queued.run.id);
  const retried = await automation.retryAutomationRun(queued.run.id);
  assert.equal(retried.requestedImageCount, 0);
  assert.equal(h.sqlite.prepare("SELECT requested_image_count n FROM automation_runs").get().n, 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM automation_steps WHERE step_type='image'").get().n, 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM automation_steps WHERE step_type IN ('content','finalize') AND status='queued'").get().n, 2);
});

test("a source added after the durable optimization snapshot blocks finalization", async () => {
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

test("the worker cancels legacy image work while an older source-only SKU finalizes", async () => {
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
  h.sqlite.prepare("UPDATE automation_runs SET requested_image_count=4, prompt_version='taha-lifestyle-v3' WHERE id=?").run(later.run.id);
  h.sqlite.prepare(`INSERT INTO automation_steps
    (id,workspace_id,run_id,step_type,ordinal,status,available_at,attempt_count,max_attempts,result_json,created_at,updated_at)
    VALUES ('later-legacy-image',?,?, 'image',0,'queued',0,0,3,'{}',0,0)`).run(WORKSPACE, later.run.id);

  const result = await automation.runAutomationWorker({ limit: 1 });
  assert.equal(result.completed, 1, JSON.stringify(result));
  assert.equal(h.sqlite.prepare("SELECT status FROM automation_runs WHERE id=?").get(pilot.run.id).status, "completed");
  assert.equal(h.sqlite.prepare("SELECT status FROM automation_steps WHERE id='later-legacy-image'").get().status, "cancelled");
  assert.equal(h.sqlite.prepare("SELECT requested_image_count n FROM automation_runs WHERE id=?").get(later.run.id).n, 0);
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
