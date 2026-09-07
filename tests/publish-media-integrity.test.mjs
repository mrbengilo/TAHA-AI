import assert from "node:assert/strict";
import test from "node:test";
import { harness, WORKSPACE } from "./sqlite-harness.mjs";

async function generatedSet(h, productId = "product-1") {
  const integrity = h.load("lib/product-integrity.ts");
  const sources = await integrity.productSources(productId);
  const fingerprint = await integrity.productFingerprint(sources.product);
  const source = sources.images[0];
  const sourceMetadata = JSON.parse(source.metadata_json);
  const sourceVersion = sourceMetadata.md5Checksum || sourceMetadata.modifiedTime;
  const variants = ["cycling", "running", "climbing", "stream"];
  const mediaIds = [];
  for (const [index, variant] of variants.entries()) {
    const id = `generated-${productId}-${variant}`;
    const externalId = `drive-${id}`;
    const metadata = {
      googleDriveSource: { connectionId: "google-1", driveFileId: externalId, driveFolderId: `folder-${sources.sku}`, skuKey: sources.sku },
      generation: { variant, sourceMediaId: source.id, sourceExternalId: source.external_id, sourceVersion,
        sourceFingerprint: fingerprint, promptVersion: "taha-lifestyle-v3", compressionPolicy: "taha-jpeg-v1" },
    };
    h.sqlite.prepare(`INSERT INTO media_assets (id,workspace_id,source_connection_id,channel_id,media_type,origin,storage_provider,
      external_id,mime_type,byte_size,status,metadata_json,created_at,updated_at) VALUES (?,?,'google-1','google_drive','image','generated',
      'google_drive',?,'image/jpeg',150000,'ready',?,?,?)`).run(id, WORKSPACE, externalId, JSON.stringify(metadata), Date.now(), Date.now());
    h.sqlite.prepare("INSERT INTO product_media (id,workspace_id,product_id,media_id,role,sort_order,created_at) VALUES (?,?,?,?,'generated',?,?)")
      .run(`pm-${id}`, WORKSPACE, productId, id, index, Date.now());
    mediaIds.push(id);
  }
  return { mediaIds, fingerprint };
}

test("publish media gate accepts only the exact current four generated variants and prompt version", async () => {
  const h = harness(); h.seedProduct();
  const { mediaIds, fingerprint } = await generatedSet(h);
  const gate = h.load("lib/publish-media-integrity.ts");
  const platformData = { generatedImageCount: 4, imagePromptVersion: "taha-lifestyle-v3", sourceFingerprint: fingerprint };
  const accepted = await gate.assertPublishProductMedia("product-1", mediaIds, platformData);
  assert.equal(accepted.sku, "PH0001");
  await assert.rejects(gate.assertPublishProductMedia("product-1", mediaIds, { ...platformData, imagePromptVersion: "old-prompt" }), /PRODUCT_GENERATED_MEDIA_MISMATCH/);
  await assert.rejects(gate.assertPublishProductMedia("product-1", [...mediaIds].reverse(), platformData), /PRODUCT_GENERATED_MEDIA_MISMATCH/);
  await assert.rejects(gate.assertPublishProductMedia("product-1", mediaIds.slice(0, 3), platformData), /PRODUCT_GENERATED_MEDIA_MISMATCH/);
});

test("publish media gate rejects cross-SKU and replaced-source generated media", async () => {
  const h = harness(); h.seedProduct(); h.seedProduct("product-2", "PH0002");
  const { mediaIds, fingerprint } = await generatedSet(h);
  const gate = h.load("lib/publish-media-integrity.ts");
  const platformData = { generatedImageCount: 4, imagePromptVersion: "taha-lifestyle-v3", sourceFingerprint: fingerprint };
  await assert.rejects(gate.assertPublishProductMedia("product-2", mediaIds, platformData), /PRODUCT_GENERATED_MEDIA_MISMATCH/);
  h.sqlite.prepare("UPDATE media_assets SET metadata_json=json_set(metadata_json,'$.md5Checksum','replacement') WHERE id='image-product-1'").run();
  await assert.rejects(gate.assertPublishProductMedia("product-1", mediaIds, platformData), /PRODUCT_GENERATED_MEDIA_MISMATCH/);
});

test("zero-generated legacy path still requires exact raw product source media", async () => {
  const h = harness(); h.seedProduct(); h.seedProduct("product-2", "PH0002");
  const integrity = h.load("lib/product-integrity.ts");
  const fingerprint = await integrity.productFingerprint((await integrity.productSources("product-1")).product);
  const gate = h.load("lib/publish-media-integrity.ts");
  await gate.assertPublishProductMedia("product-1", ["image-product-1"], { generatedImageCount: 0, sourceFingerprint: fingerprint });
  await assert.rejects(gate.assertPublishProductMedia("product-1", ["image-product-2"], { generatedImageCount: 0, sourceFingerprint: fingerprint }), /PRODUCT_MEDIA_MISMATCH/);
});
