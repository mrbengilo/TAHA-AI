import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadPublishing({ receiver, baseUrl = "https://tahashoes.vn" } = {}) {
  const state = {
    fetchCalls: [],
    hmacCalls: [],
    failed: [],
    published: [],
    contractInput: null,
  };
  const source = await readFile(new URL("../lib/publishing.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const commonJsModule = { exports: {} };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    AbortSignal,
    Blob,
    FormData,
    Response,
    Uint8Array,
    URL,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    console,
    crypto: webcrypto,
    fetch: async (url, init) => {
      state.fetchCalls.push({ url, init });
      return receiver
        ? receiver(url, init)
        : Response.json({ id: "product-1", url: "https://tahashoes.vn/products/ph0027" });
    },
    require(specifier) {
      if (specifier === "./integrations/crypto") {
        return { hmacHex: async (secret, value) => {
          state.hmacCalls.push({ secret, value });
          return "signed-body";
        } };
      }
      if (specifier === "./integrations/connection-secrets") {
        return { getConnectedIntegration: async () => ({
          credentials: { webhookSecret: "website-secret" },
          config: { baseUrl, publishEndpoint: "https://tahashoes.vn/api/taha/publish" },
        }) };
      }
      if (specifier === "./integrations/env") return { getRuntimeEnv: () => ({ DB: {} }), requireEnv: () => "v-test" };
      if (specifier === "./integrations/facebook-permissions") return { verifyFacebookConnection: async () => ({ ready: true }) };
      if (specifier === "./integrations/store") return { TAHA_WORKSPACE_ID: "workspace-test" };
      if (specifier === "./media") {
        return { sourcePhotoBlob: async () => ({
          blob: new Blob(["image"], { type: "image/jpeg" }),
          filename: "PH0027.jpg",
          mimeType: "image/jpeg",
        }) };
      }
      if (specifier === "./publish-jobs") {
        return {
          startPublishJob: async () => ({ id: "job-1", replay: false, status: "queued" }),
          markJobBlocked: async () => {},
          markJobFailed: async (...values) => { state.failed.push(values); },
          markJobPublished: async (...values) => { state.published.push(values); },
        };
      }
      if (specifier === "./ai/shoe-content") return { customerCopyViolation: () => null };
      if (specifier === "./product-integrity") {
        return { productSources: async () => ({ product: { id: "product-1", base_sku: "PH0027" } }) };
      }
      if (specifier === "./website-product") {
        return {
          WEBSITE_PRODUCT_MAX_IMAGES: 6,
          buildWebsiteProductPayload: (input) => {
            state.contractInput = input;
            return {
              schemaVersion: "taha.website.product.v1",
              operation: "upsert_product",
              tahaJobId: input.jobId,
              idempotencyKey: input.idempotencyKey,
              product: { sku: input.product.base_sku },
            };
          },
        };
      }
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  new vm.Script(compiled, { filename: "publishing.cjs" }).runInContext(context);
  return { publishing: commonJsModule.exports, state };
}

function websiteInput() {
  return {
    connectionId: "website-1",
    jobId: "job-1",
    idempotencyKey: "schedule:website:one",
    payload: {
      productId: "product-1",
      draftId: "draft-1",
      draftVersion: 2,
      message: "Mô tả PH0027",
      mediaIds: ["media-1"],
    },
  };
}

test("accepts a complete same-origin website receipt and signs timestamp.rawBody", async () => {
  const { publishing, state } = await loadPublishing({
    receiver: async () => Response.json({
      id: "  mongo-product-id  ",
      url: " https://tahashoes.vn/products/ph0027 ",
    }, { status: 201 }),
  });

  const result = await publishing.sendWebsitePayload(websiteInput());
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    externalId: "mongo-product-id",
    externalUrl: "https://tahashoes.vn/products/ph0027",
    providerResponse: { accepted: true },
  });
  assert.equal(state.fetchCalls.length, 1);
  const request = state.fetchCalls[0].init;
  assert.equal(request.method, "POST");
  assert.equal(request.headers["x-taha-idempotency-key"], "schedule:website:one");
  assert.equal(request.headers["x-taha-signature"], "sha256=signed-body");
  assert.equal(state.hmacCalls[0].secret, "website-secret");
  assert.equal(state.hmacCalls[0].value, `${request.headers["x-taha-timestamp"]}.${request.body}`);
  assert.equal(JSON.parse(request.body).product.sku, "PH0027");
});

test("rejects incomplete, malformed, and off-origin success receipts with an idempotent retry", async () => {
  const cases = [
    ["non-JSON", () => new Response("accepted", { status: 200 })],
    ["missing id", () => Response.json({ url: "https://tahashoes.vn/products/ph0027" })],
    ["missing url", () => Response.json({ id: "product-1" })],
    ["relative url", () => Response.json({ id: "product-1", url: "/products/ph0027" })],
    ["foreign origin", () => Response.json({ id: "product-1", url: "https://tahashoes.vn.evil.example/products/ph0027" })],
    ["credentialed url", () => Response.json({ id: "product-1", url: "https://user@tahashoes.vn/products/ph0027" })],
  ];

  for (const [name, response] of cases) {
    const { publishing } = await loadPublishing({ receiver: async () => response() });
    await assert.rejects(
      publishing.sendWebsitePayload(websiteInput()),
      (error) => error.code === "WEBSITE_RECEIPT_INVALID"
        && error.outcomeUnknown === false
        && error.retryable === true,
      name,
    );
  }
});

test("keeps non-200/201 receiver errors on their existing retry path", async () => {
  const { publishing } = await loadPublishing({
    receiver: async () => Response.json({ id: "ignored", url: "https://tahashoes.vn/products/ph0027" }, { status: 503 }),
  });
  await assert.rejects(
    publishing.sendWebsitePayload(websiteInput()),
    (error) => error.code === "WEBSITE_API_503"
      && error.retryable === true
      && error.outcomeUnknown === false,
  );
});


test("website delivery sends all 27 source photos without truncating the album", async () => {
  const { publishing, state } = await loadPublishing();
  const input = websiteInput();
  input.payload.mediaIds = Array.from({ length: 27 }, (_, i) => `media-${i}`);
  await publishing.sendWebsitePayload(input);
  assert.equal(state.contractInput.media.length, 27);
});
