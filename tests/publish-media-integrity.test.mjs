import assert from "node:assert/strict";
import test from "node:test";
import { harness, WORKSPACE } from "./sqlite-harness.mjs";

test("publishing accepts every original from the exact SKU without a six or ten photo cap", async () => {
  const h = harness(); h.seedProduct();
  const original = h.sqlite.prepare("SELECT * FROM media_assets WHERE id='image-product-1'").get();
  const ids = [original.id];
  for (let i = 1; i < 27; i++) {
    const id = `original-${i}`;
    const metadata = JSON.parse(original.metadata_json);
    metadata.googleDriveSource.driveFileId = id;
    h.sqlite.prepare(`INSERT INTO media_assets (id,workspace_id,source_connection_id,channel_id,media_type,origin,storage_provider,
      external_id,mime_type,status,metadata_json,created_at,updated_at)
      VALUES (?,?,'google-1','google_drive','image','source','google_drive',?,'image/jpeg','ready',?,1,1)`)
      .run(id, WORKSPACE, id, JSON.stringify(metadata));
    h.sqlite.prepare("INSERT INTO product_media (id,workspace_id,product_id,media_id,role,sort_order,created_at) VALUES (?,?,'product-1',?,'source',?,1)")
      .run(`pm-${id}`, WORKSPACE, id, i);
    ids.push(id);
  }
  const gate = h.load("lib/publish-media-integrity.ts");
  const sources = await gate.assertPublishProductMedia("product-1", ids, { sourceImageCount: 27, generatedImageCount: 0 });
  assert.equal(sources.images.length, 27);
  await assert.rejects(gate.assertPublishProductMedia("product-1", [...ids, ids[0]], { sourceImageCount: 28, generatedImageCount: 0 }), /PRODUCT_MEDIA_MISMATCH/);
});

test("legacy generated and mixed albums cannot be published after image generation is removed", async () => {
  const h = harness(); h.seedProduct();
  const gate = h.load("lib/publish-media-integrity.ts");
  for (const mediaIds of [["generated"], ["image-product-1", "generated"]]) {
    await assert.rejects(gate.assertPublishProductMedia("product-1", mediaIds, {
      sourceImageCount: 1, generatedImageCount: 1,
    }), /PRODUCT_GENERATED_MEDIA_DISABLED/);
  }
  h.sqlite.prepare("UPDATE media_assets SET origin='generated' WHERE id='image-product-1'").run();
  await assert.rejects(gate.assertPublishProductMedia("product-1", ["image-product-1"], { sourceImageCount: 1, generatedImageCount: 0 }), /SKU_SOURCE_IMAGES_REQUIRED/);
});

test("source-only publishing still rejects cross-SKU media and stale product copy", async () => {
  const h = harness(); h.seedProduct(); h.seedProduct("product-2", "PH0002");
  const integrity = h.load("lib/product-integrity.ts");
  const fingerprint = await integrity.productFingerprint((await integrity.productSources("product-1")).product);
  const gate = h.load("lib/publish-media-integrity.ts");
  const data = { sourceImageCount: 1, generatedImageCount: 0, sourceFingerprint: fingerprint };
  await gate.assertPublishProductMedia("product-1", ["image-product-1"], data);
  await assert.rejects(gate.assertPublishProductMedia("product-1", ["image-product-2"], data), /PRODUCT_MEDIA_MISMATCH/);
  h.sqlite.prepare("UPDATE products SET description='Changed facts' WHERE id='product-1'").run();
  await assert.rejects(gate.assertPublishProductMedia("product-1", ["image-product-1"], data), /PRODUCT_CONTENT_STALE/);
});
