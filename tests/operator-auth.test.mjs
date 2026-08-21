import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadOperatorAuth(runtime = {}) {
  const source = await readFile(new URL("../lib/operator-auth.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
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
    process: { env: { NODE_ENV: "production" } },
    Request,
    TextEncoder,
    URL,
    require(specifier) {
      if (specifier === "./integrations/env") return { getRuntimeEnv: () => runtime };
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  new vm.Script(compiled, { filename: "operator-auth.cjs" }).runInContext(context);
  return commonJsModule.exports;
}

test("accepts only an explicitly allowed Sites email", async () => {
  const { isOperatorRequest } = await loadOperatorAuth({
    SITES_OPERATOR_EMAILS: "owner@example.com",
    TRUSTED_PROXY_SECRET: "proxy-secret",
  });
  const allowed = new Request("https://app.example.com/api/integrations", {
    headers: { "oai-authenticated-user-email": "Owner@Example.com", "x-taha-proxy-secret": "proxy-secret" },
  });
  const rejected = new Request("https://app.example.com/api/integrations", {
    headers: { "oai-authenticated-user-email": "other@example.com", "x-taha-proxy-secret": "proxy-secret" },
  });

  assert.equal(isOperatorRequest(allowed), true);
  assert.equal(isOperatorRequest(rejected), false);
});

test("keeps the stable Sites user ID and bearer alternatives", async () => {
  const { isOperatorRequest } = await loadOperatorAuth({
    SITES_OPERATOR_USER_IDS: "site-user-id",
    INTERNAL_API_SECRET: "internal-secret",
    TRUSTED_PROXY_SECRET: "proxy-secret",
  });

  assert.equal(isOperatorRequest(new Request("https://app.example.com", {
    headers: { "oai-authenticated-user-id": "site-user-id", "x-taha-proxy-secret": "proxy-secret" },
  })), true);
  assert.equal(isOperatorRequest(new Request("https://app.example.com", {
    headers: { authorization: "Bearer internal-secret" },
  })), true);
});

test("allows reviewers to read without granting operator access", async () => {
  const { isOperatorRequest, isViewerRequest } = await loadOperatorAuth({
    SITES_OPERATOR_USER_IDS: "owner-id",
    SITES_VIEWER_USER_IDS: "shopee-reviewer",
    TRUSTED_PROXY_SECRET: "proxy-secret",
  });
  const reviewer = new Request("https://app.example.com/api/channels", {
    headers: { "oai-authenticated-user-id": "shopee-reviewer", "x-taha-proxy-secret": "proxy-secret" },
  });

  assert.equal(isViewerRequest(reviewer), true);
  assert.equal(isOperatorRequest(reviewer), false);
});

test("rejects spoofed identity headers without the trusted proxy proof", async () => {
  const { isOperatorRequest, isViewerRequest } = await loadOperatorAuth({
    SITES_OPERATOR_EMAILS: "owner@example.com",
    SITES_VIEWER_USER_IDS: "reviewer",
    TRUSTED_PROXY_SECRET: "proxy-secret",
  });
  const spoofedOperator = new Request("https://app.example.com/api/integrations", {
    headers: { "oai-authenticated-user-email": "owner@example.com" },
  });
  const spoofedViewer = new Request("https://app.example.com/api/channels", {
    headers: { "oai-authenticated-user-id": "reviewer", "x-taha-proxy-secret": "wrong" },
  });

  assert.equal(isOperatorRequest(spoofedOperator), false);
  assert.equal(isViewerRequest(spoofedViewer), false);
});
