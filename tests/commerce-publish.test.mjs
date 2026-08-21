import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

async function loadCommonJs(relativePath, imports = {}) {
  const input = await source(relativePath);
  const compiled = ts.transpileModule(input, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const commonJsModule = { exports: {} };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    Request,
    Response,
    URL,
    console,
    crypto: globalThis.crypto,
    require(specifier) {
      if (Object.hasOwn(imports, specifier)) return imports[specifier];
      throw new Error(`Unexpected import from ${relativePath}: ${specifier}`);
    },
  });
  new vm.Script(compiled, { filename: `${relativePath}.cjs` }).runInContext(context);
  return commonJsModule.exports;
}

class CommerceStatement {
  constructor(database, query) {
    this.database = database;
    this.query = query.replace(/\s+/g, " ").trim();
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    const q = this.query;
    if (q.includes("FROM channel_connections")) return { id: "connection-tiktok", status: "connected" };
    if (q.includes("FROM content_drafts")) {
      return {
        id: "draft-1",
        title: "Giày TAHA chính hãng",
        body: "Mô tả listing đã được duyệt.",
        platform_data_json: JSON.stringify({ categoryId: "leaf", warehouseId: "warehouse-1" }),
        version: 4,
      };
    }
    if (q.includes("FROM products") && q.includes("deleted_at IS NULL")) {
      return {
        id: "product-1",
        name: "Giày TAHA",
        description: "Mô tả sản phẩm",
        currency: "VND",
        version: 9,
      };
    }
    if (q.includes("FROM publish_jobs existing")) {
      const [workspaceId, connectionId, productId, dedupeKey] = this.values;
      return [...this.database.jobsByDedupe.values()]
        .filter((job) => job.workspace_id === workspaceId
          && job.connection_id === connectionId
          && job.product_id === productId
          && job.job_kind === "listing_upsert"
          && job.dedupe_key !== dedupeKey)
        .sort((left, right) => left.created_at - right.created_at)
        .find((job) => ["queued", "retry_wait", "publishing"].includes(job.status)
          || job.error_code === "TIKTOK_MAPPING_PENDING"
          || job.error_code === "DELIVERY_OUTCOME_UNKNOWN"
          || job.external_post_id) ?? null;
    }
    if (q.includes("FROM channel_mappings")) {
      const result = this.database.mappingVisible ? { external_id: "tts-mapped" } : null;
      if (this.database.mappingAppearsAfterFirstRead) {
        this.database.mappingAppearsAfterFirstRead = false;
        this.database.mappingVisible = true;
      }
      return result;
    }
    if (q.includes("FROM publish_jobs") && q.includes("dedupe_key = ?")) {
      return this.database.jobsByDedupe.get(this.values[1]) ?? null;
    }
    throw new Error(`Unhandled commerce first(): ${q}`);
  }

  async all() {
    const q = this.query;
    if (q.includes("FROM product_variants")) {
      return { results: [{ id: "variant-1", sku: "TAHA-001", price_minor: 490000, inventory_quantity: 12 }] };
    }
    if (q.includes("FROM content_draft_media")) {
      return { results: Array.from({ length: 6 }, (_, index) => ({ media_id: `media-ai-${index + 1}` })) };
    }
    throw new Error(`Unhandled commerce all(): ${q}`);
  }

  async run() {
    const q = this.query;
    if (!q.startsWith("INSERT INTO publish_jobs")) throw new Error(`Unhandled commerce run(): ${q}`);
    const [id, workspaceId, connectionId, productId, draftId, dedupeKey, scheduledFor, , payload, ,] = this.values;
    if (this.database.jobsByDedupe.has(dedupeKey)) return { meta: { changes: 0 } };
    if (this.database.mappingVisible) return { meta: { changes: 0 } };
    const blocker = [...this.database.jobsByDedupe.values()].find((job) => (
      job.workspace_id === workspaceId
      && job.connection_id === connectionId
      && job.product_id === productId
      && job.job_kind === "listing_upsert"
      && job.dedupe_key !== dedupeKey
      && (["queued", "retry_wait", "publishing"].includes(job.status)
        || job.error_code === "TIKTOK_MAPPING_PENDING"
        || job.error_code === "DELIVERY_OUTCOME_UNKNOWN"
        || job.external_post_id)
    ));
    if (blocker) return { meta: { changes: 0 } };
    const job = {
      id,
      workspace_id: workspaceId,
      connection_id: connectionId,
      product_id: productId,
      draft_id: draftId,
      job_kind: "listing_upsert",
      dedupe_key: dedupeKey,
      status: "queued",
      scheduled_for: scheduledFor,
      payload_snapshot_json: payload,
      external_post_id: null,
      error_code: null,
      created_at: scheduledFor,
    };
    this.database.jobsByDedupe.set(dedupeKey, job);
    return { meta: { changes: 1 } };
  }
}

class CommerceDatabase {
  constructor(jobs = []) {
    this.jobsByDedupe = new Map(jobs.map((job) => [job.dedupe_key, { ...job }]));
    this.mappingVisible = false;
    this.mappingAppearsAfterFirstRead = false;
  }

  prepare(query) {
    return new CommerceStatement(this, query);
  }
}

async function loadCommerce(database) {
  return loadCommonJs("lib/commerce-publish.ts", {
    "./integrations/env": { getRuntimeEnv: () => ({ DB: database }) },
    "./integrations/store": { TAHA_WORKSPACE_ID: "workspace-1" },
    "./tiktok-shop-listing": {
      parseTikTokListingConfig: (value) => value,
      preflightTikTokListing: () => [],
    },
  });
}

test("TikTok one-click publish queues one versioned listing job and replays the same request", async () => {
  const database = new CommerceDatabase();
  const commerce = await loadCommerce(database);

  const first = await commerce.queueCommerceProductPublish("tiktok_shop", "product-1");
  const replay = await commerce.queueCommerceProductPublish("tiktok_shop", "product-1");

  assert.equal(database.jobsByDedupe.size, 1);
  assert.equal(first.job.job_kind, "listing_upsert");
  assert.equal(first.job.status, "queued");
  assert.equal(first.job.dedupe_key, "commerce:tiktok_shop:connection-tiktok:product-1:p9:d4");
  assert.equal(first.replayed, false);
  assert.equal(replay.job.id, first.job.id);
  assert.equal(replay.replayed, true, "the second identical click must be reported as an idempotent replay");

  const payload = JSON.parse(first.job.payload_snapshot_json);
  assert.equal(payload.provider, "tiktok_shop");
  assert.equal(payload.contentType, "product_listing");
  assert.equal(payload.productVersion, 9);
  assert.equal(payload.draftVersion, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(payload.productSnapshot)), {
    id: "product-1",
    name: "Giày TAHA chính hãng",
    description: "Mô tả listing đã được duyệt.",
    currency: "VND",
    version: 9,
    variants: [{
      id: "variant-1",
      sku: "TAHA-001",
      priceMinor: 490000,
      inventoryQuantity: 12,
    }],
  });
  assert.deepEqual(Array.from(payload.mediaIds), [
    "media-ai-1", "media-ai-2", "media-ai-3", "media-ai-4", "media-ai-5", "media-ai-6",
  ]);
  assert.equal("appSecret" in payload, false);
  assert.equal("accessToken" in payload, false);
});

test("TikTok queue atomically blocks another job while the product is in flight", async () => {
  for (const status of ["queued", "retry_wait", "publishing"]) {
    const database = new CommerceDatabase([{
      id: `old-${status}`,
      workspace_id: "workspace-1",
      connection_id: "connection-tiktok",
      product_id: "product-1",
      job_kind: "listing_upsert",
      dedupe_key: `commerce:tiktok_shop:connection-tiktok:product-1:old-${status}`,
      status,
      external_post_id: null,
      error_code: null,
      created_at: 1,
    }]);
    const commerce = await loadCommerce(database);
    await assert.rejects(
      commerce.queueCommerceProductPublish("tiktok_shop", "product-1"),
      (error) => error.code === "TIKTOK_PRODUCT_PUBLISH_IN_FLIGHT" && error.status === 409,
    );
    assert.equal(database.jobsByDedupe.size, 1, `${status} must not allow a second remote create job`);
  }
});

test("TikTok queue blocks a remote product whose local mapping is pending", async () => {
  const database = new CommerceDatabase([{
    id: "mapping-pending",
    workspace_id: "workspace-1",
    connection_id: "connection-tiktok",
    product_id: "product-1",
    job_kind: "listing_upsert",
    dedupe_key: "commerce:tiktok_shop:connection-tiktok:product-1:old",
    status: "blocked",
    external_post_id: "tts-remote-1",
    error_code: "TIKTOK_MAPPING_PENDING",
    created_at: 1,
  }]);
  const commerce = await loadCommerce(database);
  await assert.rejects(
    commerce.queueCommerceProductPublish("tiktok_shop", "product-1"),
    (error) => error.code === "TIKTOK_PRODUCT_RECONCILIATION_REQUIRED" && error.status === 409,
  );
  assert.equal(database.jobsByDedupe.size, 1);
});

test("TikTok queue blocks an unknown remote outcome even before an external ID is recovered", async () => {
  const database = new CommerceDatabase([{
    id: "unknown-outcome",
    workspace_id: "workspace-1",
    connection_id: "connection-tiktok",
    product_id: "product-1",
    job_kind: "listing_upsert",
    dedupe_key: "commerce:tiktok_shop:connection-tiktok:product-1:old",
    status: "blocked",
    external_post_id: null,
    error_code: "DELIVERY_OUTCOME_UNKNOWN",
    created_at: 1,
  }]);
  const commerce = await loadCommerce(database);
  await assert.rejects(
    commerce.queueCommerceProductPublish("tiktok_shop", "product-1"),
    (error) => error.code === "TIKTOK_PRODUCT_RECONCILIATION_REQUIRED" && error.status === 409,
  );
  assert.equal(database.jobsByDedupe.size, 1, "an unknown Create Product outcome must block a new job ID");
});

test("TikTok queue atomically notices a mapping committed after its initial preflight", async () => {
  const database = new CommerceDatabase();
  database.mappingAppearsAfterFirstRead = true;
  const commerce = await loadCommerce(database);
  await assert.rejects(
    commerce.queueCommerceProductPublish("tiktok_shop", "product-1"),
    (error) => error.code === "TIKTOK_PRODUCT_UPDATE_REQUIRES_REMOTE_SNAPSHOT" && error.status === 409,
  );
  assert.equal(database.jobsByDedupe.size, 0);
});

test("Shopee publish remains explicitly pending until Open Platform approval", async () => {
  const commerce = await loadCommerce(null);
  await assert.rejects(
    commerce.queueCommerceProductPublish("shopee", "product-1"),
    (error) => {
      assert.equal(error.code, "SHOPEE_APPROVAL_PENDING");
      assert.equal(error.status, 409);
      assert.doesNotMatch(JSON.stringify(error), /partner[_ -]?key|access[_ -]?token|secret/i);
      return true;
    },
  );
});

function apiHelpers() {
  return {
    ok(data, init) {
      return Response.json({ data }, { status: 200, ...init });
    },
    fail(code, message, status = 400, details) {
      return Response.json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, { status });
    },
  };
}

test("commerce publish route checks operator access before reading input or touching the queue", async () => {
  let calls = 0;
  class CommercePublishError extends Error {}
  const route = await loadCommonJs("app/api/commerce/[provider]/products/[productId]/publish/route.ts", {
    "../../../../../../../lib/api": apiHelpers(),
    "../../../../../../../lib/commerce-publish": {
      CommercePublishError,
      queueCommerceProductPublish: async () => { calls += 1; return { job: {} }; },
    },
    "../../../../../../../lib/operator-auth": { isOperatorRequest: () => false },
  });

  const response = await route.POST(
    new Request("https://tahashoes.store/api/commerce/tiktok_shop/products/product-1/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: "connection-tiktok" }),
    }),
    { params: Promise.resolve({ provider: "tiktok_shop", productId: "product-1" }) },
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "UNAUTHORIZED");
  assert.equal(calls, 0);
});

test("TikTok configuration route is operator-only and persists official listing identifiers separately from AI copy", async () => {
  let calls = 0;
  class CommercePublishError extends Error {}
  const route = await loadCommonJs("app/api/commerce/tiktok_shop/products/[productId]/configuration/route.ts", {
    "../../../../../../../lib/api": apiHelpers(),
    "../../../../../../../lib/commerce-publish": {
      CommercePublishError,
      saveTikTokListingConfiguration: async () => { calls += 1; return { ready: true }; },
    },
    "../../../../../../../lib/operator-auth": { isOperatorRequest: () => false },
  });
  const response = await route.PUT(
    new Request("https://tahashoes.store/api/commerce/tiktok_shop/products/product-1/configuration", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ categoryId: "category", warehouseId: "warehouse", weightValue: 500 }),
    }),
    { params: Promise.resolve({ productId: "product-1" }) },
  );
  assert.equal(response.status, 401);
  assert.equal(calls, 0);

  const sourceText = await source("lib/commerce-publish.ts");
  assert.match(sourceText, /saveTikTokListingConfiguration/);
  assert.match(sourceText, /salesAttributesBySku/);
  assert.match(sourceText, /packageWeight/);
  assert.match(sourceText, /version = version \+ 1/);
});

test("commerce queue contract requires an approved listing, ready images, a connected channel, and no existing remote mapping", async () => {
  const input = await source("lib/commerce-publish.ts");
  assert.match(input, /connection\.status !== "connected"/);
  assert.match(input, /content_type = 'product_listing' AND status = 'approved'/);
  assert.match(input, /m\.status = 'ready' AND m\.media_type = 'image'/);
  assert.match(input, /LIMIT 9/);
  assert.match(input, /FROM channel_mappings/);
  assert.match(input, /TIKTOK_PRODUCT_UPDATE_REQUIRES_REMOTE_SNAPSHOT/);
  assert.match(input, /productSnapshot: product/);
  assert.match(input, /WHERE NOT EXISTS \(/);
  assert.match(input, /existing\.status IN \('queued', 'retry_wait', 'publishing'\)/);
  assert.match(input, /existing\.external_post_id IS NOT NULL/);
  assert.match(input, /TIKTOK_MAPPING_PENDING/);
  assert.match(input, /DELIVERY_OUTCOME_UNKNOWN/);
  assert.match(input, /ON CONFLICT\(dedupe_key\) DO NOTHING/);
});

test("commerce source and route contain no embedded platform credentials or raw-error response", async () => {
  const combined = `${await source("lib/commerce-publish.ts")}\n${await source("app/api/commerce/[provider]/products/[productId]/publish/route.ts")}`;
  assert.doesNotMatch(combined, /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/);
  assert.doesNotMatch(combined, /(?:TIKTOK_SHOP_APP_SECRET|SHOPEE_PARTNER_KEY)\s*[:=]\s*["'][^"']+["']/);
  assert.doesNotMatch(combined, /return\s+fail\([^;]*error\.message/s);
  assert.doesNotMatch(combined, /payload\s*=\s*\{[^}]*?(?:secret|token|authorization)/is);
});
