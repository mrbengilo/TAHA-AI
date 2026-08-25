import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function section(input, start, end) {
  const from = input.indexOf(start);
  const to = input.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return input.slice(from, to);
}

async function loadCommonJs(relativePath, imports = {}, globals = {}) {
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
    AbortSignal,
    Blob,
    FormData,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    Uint8Array,
    console,
    crypto: globalThis.crypto,
    ...globals,
    require(specifier) {
      if (Object.hasOwn(imports, specifier)) return imports[specifier];
      throw new Error(`Unexpected import from ${relativePath}: ${specifier}`);
    },
  });
  new vm.Script(compiled, { filename: `${relativePath}.cjs` }).runInContext(context);
  return commonJsModule.exports;
}

class AutomationStatement {
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
    if (q.includes("FROM products p") && q.includes("LEFT JOIN product_variants")) {
      return {
        id: "product-1",
        base_sku: "TAHA-001",
        name: "Giày TAHA",
        description: "Giày thể thao nhẹ",
        brand: "TAHA",
        category: "Sneaker",
        currency: "VND",
        price_minor: 490000,
        compare_at_price_minor: null,
        inventory_quantity: 12,
      };
    }
    if (q.includes("SELECT m.id FROM product_media") || q.includes("SELECT m.id FROM media_assets")) {
      return { id: "media-source-1" };
    }
    if (q.includes("FROM automation_runs WHERE workspace_id = ? AND request_key = ?")) {
      return this.database.runsByKey.get(this.values[1]) ?? null;
    }
    if (q.includes("FROM automation_runs") && q.includes("product_id = ?") && q.includes("status IN ('queued', 'processing')")) {
      if (this.database.activeReadsToHide > 0) {
        this.database.activeReadsToHide -= 1;
        return null;
      }
      return [...this.database.runsById.values()].find((run) =>
        run.workspace_id === this.values[0]
        && run.product_id === this.values[1]
        && ["queued", "processing"].includes(run.status)) ?? null;
    }
    if (q.includes("FROM automation_runs") && q.includes("status IN ('queued', 'processing')")) {
      return null;
    }
    if (q.includes("FROM automation_runs WHERE id = ? AND workspace_id = ?")) {
      return this.database.runsById.get(this.values[0]) ?? null;
    }
    throw new Error(`Unhandled automation first(): ${q}`);
  }

  async all() {
    const q = this.query;
    if (q.includes("SELECT m.id FROM product_media") && q.includes("m.origin = 'source'")) {
      return { results: [{ id: "media-source-1" }, { id: "media-source-2" }] };
    }
    return { results: [] };
  }

  async run() {
    const q = this.query;
    if (q.startsWith("INSERT INTO automation_runs")) {
      const [id, workspaceId, productId, sourceMediaId, requestKey, imageCount, targets, createdBy, createdAt, updatedAt] = this.values;
      const active = [...this.database.runsById.values()].find((run) =>
        run.workspace_id === workspaceId
        && run.product_id === productId
        && ["queued", "processing"].includes(run.status));
      if (active || this.database.runsByKey.has(requestKey)) {
        throw new Error("D1_ERROR: UNIQUE constraint failed: automation_runs.workspace_id, automation_runs.product_id");
      }
      const row = {
        id,
        workspace_id: workspaceId,
        product_id: productId,
        source_media_id: sourceMediaId,
        request_key: requestKey,
        status: "queued",
        requested_image_count: imageCount,
        completed_image_count: 0,
        target_providers_json: targets,
        content_json: null,
        output_media_ids_json: "[]",
        text_model: null,
        image_model: null,
        prompt_version: "taha-product-v1",
        error_code: null,
        error_message: null,
        created_by: createdBy,
        created_at: createdAt,
        updated_at: updatedAt,
        started_at: null,
        completed_at: null,
      };
      this.database.runsById.set(id, row);
      this.database.runsByKey.set(requestKey, row);
      return { meta: { changes: 1 } };
    }
    if (q.startsWith("INSERT INTO automation_steps")) {
      const stepType = q.includes("'content'") ? "content" : q.includes("'image'") ? "image" : "finalize";
      this.database.steps.push({
        id: this.values[0],
        runId: this.values[2],
        stepType,
        ordinal: stepType === "image" ? this.values[3] : 0,
      });
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unhandled automation run(): ${q}`);
  }
}

class AutomationDatabase {
  constructor() {
    this.runsById = new Map();
    this.runsByKey = new Map();
    this.steps = [];
    this.activeReadsToHide = 0;
  }

  prepare(query) {
    return new AutomationStatement(this, query);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

async function loadAutomation(database) {
  return loadCommonJs("lib/automation.ts", {
    "./ai/openai": {
      generateProductContent: async () => { throw new Error("not used by queue contract"); },
      editProductImage: async () => { throw new Error("not used by queue contract"); },
    },
    "./integrations/env": { getRuntimeEnv: () => ({ DB: database }) },
    "./integrations/google-sync": { exportGeneratedImageToGoogleDrive: async () => ({}) },
    "./integrations/store": { ensureWorkspace: async () => {}, TAHA_WORKSPACE_ID: "workspace-1" },
    "./media": { mediaBlob: async () => { throw new Error("not used by queue contract"); } },
  });
}

test("automation queue is idempotent and defaults to exactly six generated-image steps", async () => {
  const database = new AutomationDatabase();
  const automation = await loadAutomation(database);
  const input = {
    productId: "product-1",
    sourceMediaId: "media-source-1",
    idempotencyKey: "product-1-generation-v1",
  };

  const first = await automation.queueAutomationRun(input, "operator-1");
  assert.equal(first.replayed, false);
  assert.equal(first.run.requestedImageCount, 6);
  assert.equal(database.steps.length, 8);
  assert.deepEqual(
    database.steps.map((step) => `${step.stepType}:${step.ordinal}`),
    ["content:0", "image:1", "image:2", "image:3", "image:4", "image:5", "image:6", "finalize:0"],
  );

  const replay = await automation.queueAutomationRun(input, "operator-2");
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.id, first.run.id);
  assert.equal(database.steps.length, 8, "a replay must not enqueue duplicate AI/image work");

  await assert.rejects(
    automation.queueAutomationRun({ ...input, imageCount: 5 }, "operator-1"),
    (error) => error.code === "IDEMPOTENCY_KEY_REUSED" && error.status === 409,
  );
});

test("automation image count cannot exceed the six layouts promised by the product workflow", async () => {
  const database = new AutomationDatabase();
  const automation = await loadAutomation(database);
  await assert.rejects(
    automation.queueAutomationRun({
      productId: "product-1",
      idempotencyKey: "product-1-too-many-images",
      imageCount: 7,
    }),
    (error) => error.code === "IMAGE_COUNT_INVALID" && error.status === 400,
  );
  assert.equal(database.steps.length, 0);
});

test("the database invariant atomically rejects concurrent runs for one product across different keys and targets", async () => {
  const database = new AutomationDatabase();
  // Force both requests past the advisory pre-check. The partial unique index
  // simulation remains the final authority, mirroring two concurrent D1 calls.
  database.activeReadsToHide = 2;
  const automation = await loadAutomation(database);
  const results = await Promise.allSettled([
    automation.queueAutomationRun({
      productId: "product-1",
      sourceMediaId: "media-source-1",
      idempotencyKey: "concurrent-facebook-run",
      targetProviders: ["facebook"],
    }),
    automation.queueAutomationRun({
      productId: "product-1",
      sourceMediaId: "media-source-1",
      idempotencyKey: "concurrent-website-run",
      targetProviders: ["website"],
    }),
  ]);

  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "AUTOMATION_ALREADY_RUNNING");
  assert.equal(rejected[0].reason.status, 409);
  assert.equal(database.runsById.size, 1);
  assert.equal(database.steps.length, 8);
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

test("automation mutation routes enforce operator access before queueing or cancelling", async () => {
  let queued = 0;
  let cancelled = 0;
  let retried = 0;
  class AutomationError extends Error {}
  const automationStub = {
    AutomationError,
    listAutomationRuns: async () => [],
    queueAutomationRun: async () => { queued += 1; return { run: {}, replayed: false }; },
    cancelAutomationRun: async () => { cancelled += 1; return { id: "run-1", status: "cancelled" }; },
    retryAutomationRun: async () => { retried += 1; return { id: "run-1", status: "processing" }; },
  };
  const auth = { isOperatorRequest: () => false, isViewerRequest: () => false };
  const collection = await loadCommonJs("app/api/automation-runs/route.ts", {
    "../../../lib/api": apiHelpers(),
    "../../../lib/automation": automationStub,
    "../../../lib/operator-auth": auth,
  });
  const cancel = await loadCommonJs("app/api/automation-runs/[id]/cancel/route.ts", {
    "../../../../../lib/api": apiHelpers(),
    "../../../../../lib/automation": automationStub,
    "../../../../../lib/operator-auth": auth,
  });
  const retry = await loadCommonJs("app/api/automation-runs/[id]/retry/route.ts", {
    "../../../../../lib/api": apiHelpers(),
    "../../../../../lib/automation": automationStub,
    "../../../../../lib/operator-auth": auth,
  });

  const queueResponse = await collection.POST(new Request("https://tahashoes.store/api/automation-runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId: "product-1", idempotencyKey: "key-12345678" }),
  }));
  const cancelResponse = await cancel.POST(
    new Request("https://tahashoes.store/api/automation-runs/run-1/cancel", { method: "POST" }),
    { params: Promise.resolve({ id: "run-1" }) },
  );
  const retryResponse = await retry.POST(
    new Request("https://tahashoes.store/api/automation-runs/run-1/retry", { method: "POST" }),
    { params: Promise.resolve({ id: "run-1" }) },
  );

  assert.equal(queueResponse.status, 401);
  assert.equal(cancelResponse.status, 401);
  assert.equal(retryResponse.status, 401);
  assert.equal((await queueResponse.json()).error.code, "UNAUTHORIZED");
  assert.equal((await cancelResponse.json()).error.code, "UNAUTHORIZED");
  assert.equal(queued, 0);
  assert.equal(cancelled, 0);
  assert.equal(retried, 0);
});

test("failed automation runs can be resumed after Google reauthorization without regenerating completed steps", async () => {
  const input = await source("lib/automation.ts");
  assert.match(input, /export async function retryAutomationRun/);
  assert.match(input, /status IN \('failed', 'cancelled'\)/);
  assert.match(input, /attempt_count = 0/);
  assert.match(input, /status IN \('generated', 'derived'\)|origin IN \('generated', 'derived'\)/);
});

test("cron and Worker scheduled handlers run automation, scheduler, and dispatcher", async () => {
  const [cron, worker] = await Promise.all([
    source("app/api/internal/cron/tick/route.ts"),
    source("worker/index.ts"),
  ]);

  for (const input of [cron, worker]) {
    assert.match(input, /runAutomationWorker\s*\(/);
    assert.match(input, /runSchedulerTick\s*\(/);
    assert.match(input, /runPublishDispatcher\s*\(/);
  }
  assert.match(cron, /INTERNAL_API_SECRET/);
  assert.match(cron, /constantTimeEqual\s*\(/);
  assert.match(cron, /cache-control["']?\s*:\s*["']no-store["']/i);
  assert.match(
    cron,
    /const scheduler = await runSchedulerTick\(\);[\s\S]*const dispatcher = await runPublishDispatcher\(\);[\s\S]*automation = await runAutomationWorker/,
    "publishing deadlines must be processed before long-running image generation",
  );
});

test("image automation uses a long lease and requires Drive export before completing the step", async () => {
  const input = await source("lib/automation.ts");
  assert.match(input, /AUTOMATION_LEASE_MS\s*=\s*15\s*\*\s*60_000/);
  assert.match(input, /const driveExport = await exportGeneratedImageToGoogleDrive/);
  assert.doesNotMatch(input, /driveExport\s*=\s*\{\s*status:\s*["']pending["']/);
  assert.ok(
    input.indexOf("const driveExport = await exportGeneratedImageToGoogleDrive") < input.indexOf("await finishImageStep"),
    "Drive export must succeed before an image step is marked complete",
  );
});

test("automation schema and migration enforce unique run and step identities", async () => {
  const [schema, migration] = await Promise.all([
    source("db/schema.ts"),
    source("drizzle/0003_lazy_hellcat.sql"),
  ]);
  assert.match(schema, /uq_automation_runs_workspace_request_key/);
  assert.match(schema, /uq_automation_runs_active_product/);
  assert.match(schema, /\.where\(sql`\$\{table\.status\} IN \('queued', 'processing'\)`\)/);
  assert.match(schema, /uq_automation_steps_run_type_ordinal/);
  assert.match(migration, /UNIQUE INDEX `uq_automation_runs_workspace_request_key`/);
  assert.match(migration, /UNIQUE INDEX `uq_automation_runs_active_product`[^;]+WHERE `status` IN \('queued', 'processing'\)/);
  assert.match(migration, /UNIQUE INDEX `uq_automation_steps_run_type_ordinal`/);
});

test("finalize pauses only old one-time automation schedules", async () => {
  const automation = await source("lib/automation.ts");
  const pause = automation.match(/UPDATE schedules SET status = 'paused'[\s\S]*?AND draft_id IN \([\s\S]*?\)`,/);
  assert.ok(pause, "finalize must contain a bounded schedule pause statement");
  assert.match(pause[0], /status = 'active'/);
  assert.match(pause[0], /schedule_kind = 'once'/);
  assert.match(pause[0], /created_by GLOB 'automation:\*'/);
  assert.doesNotMatch(pause[0], /schedule_kind IN \('daily', 'weekly'\)/);
});

test("cancelled or expired work cannot commit AI output, drafts, schedules, retries, or final status", async () => {
  const input = await source("lib/automation.ts");
  const claim = section(input, "async function claimStep", "function safeErrorCode");
  const content = section(input, "async function processContent", "function imageExtension");
  const image = section(input, "async function processImage", "function channelContent");
  const finalize = section(input, "async function processFinalize", "async function retryOrFail");
  const retry = section(input, "async function retryOrFail", "export async function runAutomationWorker");

  assert.match(claim, /r\.status IN \('queued', 'processing'\)/);
  for (const guarded of [content, image, finalize, retry]) {
    assert.match(guarded, /r\.status IN \('queued', 'processing'\)/);
    assert.match(guarded, /lease_owner = \?/);
    assert.match(guarded, /lease_expires_at > \?/);
  }

  assert.match(content, /const saved = await db\.batch\(\[/);
  assert.match(content, /changes\(saved\[0\]\) === 0 \|\| changes\(saved\[1\]\) === 0/);
  assert.match(image, /INSERT INTO media_assets[\s\S]*?SELECT[\s\S]*?WHERE EXISTS/);
  assert.match(finalize, /INSERT INTO content_drafts[\s\S]*?SELECT[\s\S]*?WHERE EXISTS/);
  assert.match(finalize, /INSERT INTO schedules[\s\S]*?SELECT[\s\S]*?WHERE EXISTS/);
  assert.match(finalize, /UPDATE automation_runs SET status = 'completed'[\s\S]*?s\.lease_owner = \?[\s\S]*?s\.lease_expires_at > \?/);
  assert.match(retry, /UPDATE automation_runs SET status = 'failed'[\s\S]*?s\.lease_owner = \?[\s\S]*?s\.lease_expires_at > \?/);
});

test("image completion atomically reconciles aggregate media state and finalize trusts completed steps", async () => {
  const input = await source("lib/automation.ts");
  const finish = section(input, "async function finishImageStep", "async function processImage");
  const finalize = section(input, "async function processFinalize", "async function retryOrFail");

  assert.match(finish, /const saved = await db\.batch\(\[/);
  const complete = finish.indexOf("UPDATE automation_steps SET status = 'completed'");
  const aggregate = finish.indexOf("UPDATE automation_runs SET");
  const release = finish.indexOf("UPDATE automation_steps SET lease_owner = NULL");
  assert.ok(complete >= 0 && complete < aggregate && aggregate < release, "step, aggregate, and lease release must share one ordered D1 batch");
  assert.match(finish, /completed_image_count = \([\s\S]*?COUNT\(\*\)[\s\S]*?s\.status = 'completed'/);
  assert.match(finish, /output_media_ids_json = COALESCE\([\s\S]*?json_group_array\(media_id\)/);
  assert.match(finish, /json_type\(s\.result_json, '\$\.mediaId'\) = 'text'/);
  assert.match(finish, /saved\.some\(\(entry\) => changes\(entry\) === 0\)/);

  assert.match(finalize, /SELECT ordinal, result_json FROM automation_steps[\s\S]*?step_type = 'image' AND status = 'completed'[\s\S]*?ORDER BY ordinal/);
  assert.doesNotMatch(finalize, /current\.output_media_ids_json/);
  assert.match(finalize, /completed_image_count = \?, output_media_ids_json = \?/);
});

test("automation and cron source expose only normalized errors and contain no embedded API keys", async () => {
  const combined = (await Promise.all([
    source("lib/automation.ts"),
    source("lib/ai/openai.ts"),
    source("app/api/automation-runs/route.ts"),
    source("app/api/internal/cron/tick/route.ts"),
    source("worker/index.ts"),
  ])).join("\n");

  assert.doesNotMatch(combined, /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/);
  assert.doesNotMatch(combined, /OPENAI_API_KEY\s*[:=]\s*["'][^"']+["']/);
  assert.match(combined, /safeErrorCode\s*\(/);
  assert.match(combined, /OPENAI_RATE_LIMITED/);
  assert.doesNotMatch(combined, /return\s+fail\([^;]*error\.message/s);
});
