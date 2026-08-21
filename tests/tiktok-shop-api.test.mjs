import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadApi() {
  const source = await readFile(new URL("../lib/integrations/tiktok-shop-api.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const commonJsModule = { exports: {} };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    URL,
    Blob,
    FormData,
    Response,
    AbortSignal,
    fetch,
    console,
    require(specifier) {
      if (specifier === "./crypto") return { hmacHex: async (_secret, value) => `signed:${value}` };
      if (specifier === "./env") {
        return {
          getRuntimeEnv: () => ({}),
          requireEnv: (name) => ({ TIKTOK_SHOP_APP_KEY: "app", TIKTOK_SHOP_APP_SECRET: "secret" })[name],
        };
      }
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  new vm.Script(compiled, { filename: "tiktok-shop-api.cjs" }).runInContext(context);
  return commonJsModule.exports;
}

test("TikTok signature input sorts query keys and excludes sign/access_token", async () => {
  const api = await loadApi();
  const input = api.canonicalTikTokShopSignatureInput({
    appSecret: "secret",
    path: "/product/202309/products",
    query: {
      timestamp: 100,
      sign: "old",
      shop_cipher: "shop",
      access_token: "must-not-sign",
      app_key: "app",
    },
    bodyText: '{"title":"TAHA"}',
  });
  assert.equal(
    input,
    'secret/product/202309/productsapp_keyappshop_ciphershoptimestamp100{"title":"TAHA"}secret',
  );
});

test("TikTok multipart signatures never include form bytes", async () => {
  const api = await loadApi();
  const input = api.canonicalTikTokShopSignatureInput({
    appSecret: "secret",
    path: "/product/202309/images/upload",
    query: { timestamp: 100, app_key: "app" },
    bodyText: "binary-form-boundary",
    multipart: true,
  });
  assert.equal(input, "secret/product/202309/images/uploadapp_keyapptimestamp100secret");
});

test("Create Product sends the idempotency key in the signed JSON body", async () => {
  const api = await loadApi();
  let capturedUrl = null;
  let capturedOptions = null;
  const fetcher = async (url, options) => {
    capturedUrl = new URL(url);
    capturedOptions = options;
    return new Response(JSON.stringify({ code: 0, data: { product_id: "remote-1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await api.callTikTokShopJson({
    path: "/product/202309/products",
    method: "POST",
    accessToken: "token",
    query: { shop_cipher: "shop" },
    body: { save_mode: "AS_DRAFT", title: "TAHA" },
    idempotencyKey: "job-uuid",
  }, fetcher);

  assert.equal(capturedUrl.searchParams.has("idempotency_key"), false);
  assert.deepEqual(JSON.parse(capturedOptions.body), {
    save_mode: "AS_DRAFT",
    title: "TAHA",
    idempotency_key: "job-uuid",
  });
});
