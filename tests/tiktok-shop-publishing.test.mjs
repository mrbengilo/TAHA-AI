import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

class MockPublishDeliveryError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

class FakeTikTokD1 {
  constructor() {
    this.progressJson = "{}";
    this.persistChanges = 1;
    this.conflict = null;
    this.events = [];
  }

  prepare(sql) {
    if (sql.includes("FROM products") || sql.includes("FROM product_variants")) {
      throw new Error("publisher must never re-read mutable product data");
    }
    return {
      bind: (...values) => ({
        first: async () => {
          if (sql.includes("FROM publish_jobs existing")) return this.conflict;
          if (sql.includes("FROM channel_mappings")) return null;
          throw new Error(`Unexpected first: ${sql}`);
        },
        run: async () => {
          if (!sql.includes("UPDATE publish_jobs SET provider_response_json")) {
            throw new Error(`Unexpected run: ${sql}`);
          }
          this.events.push(`persist:${JSON.parse(values[0]).tiktokImageUploads.map((item) => item.mediaId).join(",")}`);
          if (this.persistChanges === 1) this.progressJson = values[0];
          return { meta: { changes: this.persistChanges } };
        },
      }),
    };
  }
}

function payload() {
  return {
    mediaIds: ["media-1", "media-2"],
    platformData: {
      tiktokShop: {
        categoryId: "category-1",
        categoryVersion: "v2",
        warehouseId: "warehouse-1",
        packageWeight: { value: 500, unit: "GRAM" },
        saveMode: "AS_DRAFT",
      },
    },
    productSnapshot: {
      id: "product-1",
      name: "Giày thể thao TAHA chính hãng",
      description: "Mô tả listing đã được duyệt.",
      currency: "VND",
      version: 9,
      variants: [{
        id: "variant-1",
        sku: "TAHA-001",
        priceMinor: 490000,
        inventoryQuantity: 12,
      }],
    },
  };
}

async function loadPublisher({ database, upload, create, media } = {}) {
  const source = await readFile(new URL("../lib/tiktok-shop-publishing.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const commonJsModule = { exports: {} };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    crypto: webcrypto,
    Blob,
    console,
    require(specifier) {
      if (specifier === "./integrations/env") return { getRuntimeEnv: () => ({ DB: database }) };
      if (specifier === "./integrations/connection-secrets") {
        return {
          getConnectedIntegration: async () => ({ config: { shopCipher: "shop-1" } }),
          getTikTokShopAccessToken: async () => "access-token",
        };
      }
      if (specifier === "./integrations/tiktok-shop-api") {
        return {
          TikTokShopApiError: class TikTokShopApiError extends Error {},
          uploadTikTokShopProductImage: upload,
          callTikTokShopJson: create,
        };
      }
      if (specifier === "./integrations/store") return { TAHA_WORKSPACE_ID: "workspace-1" };
      if (specifier === "./media") return { mediaBlob: media };
      if (specifier === "./publishing") return { PublishDeliveryError: MockPublishDeliveryError };
      if (specifier === "./tiktok-shop-listing") {
        return {
          parseTikTokListingConfig: (value) => value.tiktokShop,
          preflightTikTokListing: () => [],
          buildTikTokCreateProductBody: ({ product, config, imageUris }) => ({ product, config, imageUris }),
        };
      }
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  new vm.Script(compiled, { filename: "tiktok-shop-publishing.cjs" }).runInContext(context);
  return commonJsModule.exports;
}

function input(progress = {}) {
  return {
    connectionId: "connection-tiktok",
    jobId: "job-1",
    workerId: "worker-1",
    productId: "product-1",
    payload: payload(),
    progress,
    externalId: null,
  };
}

test("TikTok publisher uses the immutable queued snapshot and reuses persisted image URIs", async () => {
  const database = new FakeTikTokD1();
  const uploadCalls = [];
  const createCalls = [];
  let createAttempt = 0;
  const publisher = await loadPublisher({
    database,
    media: async (mediaId) => {
      database.events.push(`media:${mediaId}`);
      return { blob: new Blob([mediaId]), filename: `${mediaId}.jpg`, mimeType: "image/jpeg" };
    },
    upload: async ({ filename }) => {
      const mediaId = filename.replace(/\.jpg$/, "");
      uploadCalls.push(mediaId);
      database.events.push(`upload:${mediaId}`);
      return { uri: `uri:${mediaId}` };
    },
    create: async (request) => {
      createCalls.push(JSON.parse(JSON.stringify(request)));
      createAttempt += 1;
      if (createAttempt === 1) throw new MockPublishDeliveryError("TIKTOK_API_503", { retryable: true });
      return { data: { product_id: "remote-1", skus: [] }, requestId: "request-2" };
    },
  });

  await assert.rejects(publisher.sendTikTokShopListing(input()), (error) => error.code === "TIKTOK_API_503");
  const persisted = JSON.parse(database.progressJson);
  const result = await publisher.sendTikTokShopListing(input(persisted));

  assert.deepEqual(uploadCalls, ["media-1", "media-2"], "retry must not upload the same image again");
  assert.equal(createCalls.length, 2);
  assert.deepEqual(createCalls[0].body, createCalls[1].body, "idempotent retries must send an identical Create Product body");
  assert.equal(createCalls[0].idempotencyKey, "job-1");
  assert.equal(createCalls[1].idempotencyKey, "job-1");
  assert.equal(createCalls[0].body.product.currency, "VND");
  assert.equal(createCalls[0].body.product.variants[0].inventoryQuantity, 12);
  assert.deepEqual(createCalls[0].body.imageUris, ["uri:media-1", "uri:media-2"]);
  assert.equal(result.externalId, "remote-1");
  assert.deepEqual(database.events, [
    "media:media-1", "upload:media-1", "persist:media-1",
    "media:media-2", "upload:media-2", "persist:media-1,media-2",
  ]);
});

test("TikTok publisher resumes a partially uploaded image set without re-uploading completed media", async () => {
  const database = new FakeTikTokD1();
  const mediaCalls = [];
  const uploadCalls = [];
  let mediaTwoAttempts = 0;
  let createCalls = 0;
  const publisher = await loadPublisher({
    database,
    media: async (mediaId) => {
      mediaCalls.push(mediaId);
      return { blob: new Blob([mediaId]), filename: `${mediaId}.jpg`, mimeType: "image/jpeg" };
    },
    upload: async ({ filename }) => {
      const mediaId = filename.replace(/\.jpg$/, "");
      uploadCalls.push(mediaId);
      if (mediaId === "media-2" && mediaTwoAttempts++ === 0) {
        throw new MockPublishDeliveryError("TIKTOK_IMAGE_UPLOAD_503", { retryable: true });
      }
      return { uri: `uri:${mediaId}` };
    },
    create: async (request) => {
      createCalls += 1;
      assert.equal(JSON.stringify(request.body.imageUris), JSON.stringify(["uri:media-1", "uri:media-2"]));
      return { data: { product_id: "remote-1", skus: [] }, requestId: "request" };
    },
  });

  await assert.rejects(
    publisher.sendTikTokShopListing(input()),
    (error) => error.code === "TIKTOK_IMAGE_UPLOAD_503" && error.retryable === true,
  );
  await publisher.sendTikTokShopListing(input(JSON.parse(database.progressJson)));

  assert.deepEqual(mediaCalls, ["media-1", "media-2", "media-2"]);
  assert.deepEqual(uploadCalls, ["media-1", "media-2", "media-2"]);
  assert.equal(createCalls, 1);
});

test("TikTok publisher blocks before Create Product when uploaded image state cannot be persisted", async () => {
  const database = new FakeTikTokD1();
  database.persistChanges = 0;
  let createCalls = 0;
  const publisher = await loadPublisher({
    database,
    media: async (mediaId) => ({ blob: new Blob([mediaId]), filename: `${mediaId}.jpg`, mimeType: "image/jpeg" }),
    upload: async ({ filename }) => ({ uri: `uri:${filename}` }),
    create: async () => { createCalls += 1; return { data: { product_id: "remote" }, requestId: "request" }; },
  });

  await assert.rejects(
    publisher.sendTikTokShopListing(input()),
    (error) => error.code === "TIKTOK_IMAGE_STATE_PERSIST_FAILED" && error.outcomeUnknown === true,
  );
  assert.equal(createCalls, 0);
});

test("TikTok publisher rejects missing snapshots and other in-flight or mapping-pending jobs before media upload", async () => {
  const database = new FakeTikTokD1();
  let mediaCalls = 0;
  const publisher = await loadPublisher({
    database,
    media: async () => { mediaCalls += 1; throw new Error("must not read media"); },
    upload: async () => { throw new Error("must not upload"); },
    create: async () => { throw new Error("must not create"); },
  });

  const missingSnapshot = input();
  delete missingSnapshot.payload.productSnapshot;
  await assert.rejects(
    publisher.sendTikTokShopListing(missingSnapshot),
    (error) => error.code === "TIKTOK_PRODUCT_SNAPSHOT_INVALID",
  );

  for (const status of ["queued", "retry_wait", "publishing"]) {
    database.conflict = { id: `other-${status}`, status, error_code: null, external_post_id: null };
    await assert.rejects(
      publisher.sendTikTokShopListing(input()),
      (error) => error.code === "TIKTOK_PRODUCT_PUBLISH_IN_FLIGHT",
    );
  }

  database.conflict = {
    id: "mapping-pending",
    status: "blocked",
    error_code: "TIKTOK_MAPPING_PENDING",
    external_post_id: "remote-1",
  };
  await assert.rejects(
    publisher.sendTikTokShopListing(input()),
    (error) => error.code === "TIKTOK_PRODUCT_RECONCILIATION_REQUIRED",
  );

  database.conflict = {
    id: "unknown-outcome",
    status: "blocked",
    error_code: "DELIVERY_OUTCOME_UNKNOWN",
    external_post_id: null,
  };
  await assert.rejects(
    publisher.sendTikTokShopListing(input()),
    (error) => error.code === "TIKTOK_PRODUCT_RECONCILIATION_REQUIRED",
  );
  assert.equal(mediaCalls, 0);
});
