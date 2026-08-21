import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadGoogleSync() {
  const source = await readFile(new URL("../lib/integrations/google-sync.ts", import.meta.url), "utf8");
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
    console,
    crypto: globalThis.crypto,
    fetch,
    URL,
    require(specifier) {
      if (specifier === "./env") return { getRuntimeEnv: () => ({}) };
      if (specifier === "./connection-secrets") {
        return {
          getConnectedIntegration: async () => { throw new Error("Unexpected integration access"); },
          getGoogleAccessToken: async () => { throw new Error("Unexpected token access"); },
        };
      }
      if (specifier === "./store") return { TAHA_WORKSPACE_ID: "workspace-test" };
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  new vm.Script(compiled, { filename: "google-sync.cjs" }).runInContext(context);
  return commonJsModule.exports;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("uses a valid lower Giá sale as the current price and Giá bán as compare-at price", async () => {
  const { parseGoogleCatalogRows } = await loadGoogleSync();
  const products = plain(parseGoogleCatalogRows([
    ["SKU", "Tên sản phẩm", "Giá bán", "Giá sale"],
    ["TAHA-001", "Áo linen", "450.000 đ", "349.000 đ"],
  ]));

  assert.equal(products[0].price, 349_000);
  assert.equal(products[0].compareAtPrice, 450_000);
});

test("keeps Giá bán when Giá sale is missing, invalid, equal, or higher", async () => {
  const { parseGoogleCatalogRows } = await loadGoogleSync();
  const products = plain(parseGoogleCatalogRows([
    ["SKU", "Tên sản phẩm", "Giá bán", "Giá sale"],
    ["TAHA-EMPTY", "Không sale", 450_000, ""],
    ["TAHA-INVALID", "Sale lỗi", 450_000, "không áp dụng"],
    ["TAHA-EQUAL", "Sale bằng giá", 450_000, 450_000],
    ["TAHA-HIGHER", "Sale cao hơn", 450_000, 500_000],
  ]));

  for (const product of products) {
    assert.equal(product.price, 450_000);
    assert.equal(product.compareAtPrice, null);
  }
});

test("uses Giá sale as the current price when Giá bán is absent", async () => {
  const { parseGoogleCatalogRows } = await loadGoogleSync();
  const products = plain(parseGoogleCatalogRows([
    ["SKU", "Tên sản phẩm", "Giá sale"],
    ["TAHA-SALE-ONLY", "Chỉ có giá sale", "299.000"],
  ]));

  assert.equal(products[0].price, 299_000);
  assert.equal(products[0].compareAtPrice, null);
});

test("treats English price as current and compare at price as the higher list price", async () => {
  const { parseGoogleCatalogRows } = await loadGoogleSync();
  const products = plain(parseGoogleCatalogRows([
    ["SKU", "Product name", "Price", "Compare at price"],
    ["TAHA-ENGLISH", "Linen shirt", 349_000, 450_000],
    ["TAHA-ENGLISH-NO-DISCOUNT", "Cotton shirt", 399_000, 399_000],
  ]));

  assert.equal(products[0].price, 349_000);
  assert.equal(products[0].compareAtPrice, 450_000);
  assert.equal(products[1].price, 399_000);
  assert.equal(products[1].compareAtPrice, null);
});
