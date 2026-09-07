import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function apiHelpers() {
  return {
    ok(data, init) { return Response.json({ data }, { status: 200, ...init }); },
    fail(code, message, status = 400, details) { return Response.json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, { status }); },
  };
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
