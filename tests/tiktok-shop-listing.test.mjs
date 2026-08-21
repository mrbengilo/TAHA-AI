import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadListing() {
  const source = await readFile(new URL("../lib/tiktok-shop-listing.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const commonJsModule = { exports: {} };
  const context = vm.createContext({ module: commonJsModule, exports: commonJsModule.exports });
  new vm.Script(compiled, { filename: "tiktok-shop-listing.cjs" }).runInContext(context);
  return commonJsModule.exports;
}

const product = {
  id: "product-1",
  name: "Giày thể thao TAHA chính hãng nam nữ",
  description: "Giày thể thao nhẹ, êm và phù hợp sử dụng hằng ngày.",
  currency: "VND",
  variants: [{ id: "variant-1", sku: "TAHA-01", priceMinor: 399000, inventoryQuantity: 12 }],
};

const config = {
  categoryId: "category-leaf",
  categoryVersion: "v2",
  warehouseId: "warehouse-1",
  packageWeight: { value: "0.8", unit: "KILOGRAM" },
};

test("preflight reports every blocking field instead of guessing listing data", async () => {
  const listing = await loadListing();
  const issues = listing.preflightTikTokListing({ product, config: null, imageUris: [] });
  const codes = issues.map((issue) => issue.code);
  assert.ok(codes.includes("TIKTOK_LISTING_CONFIG_REQUIRED"));
  assert.ok(codes.includes("TIKTOK_CATEGORY_REQUIRED"));
  assert.ok(codes.includes("TIKTOK_WAREHOUSE_REQUIRED"));
  assert.ok(codes.includes("TIKTOK_PACKAGE_WEIGHT_REQUIRED"));
  assert.ok(codes.includes("TIKTOK_MAIN_IMAGES_INVALID"));
});

test("builds a safe TikTok draft with exact local SKU, price and stock", async () => {
  const listing = await loadListing();
  const body = listing.buildTikTokCreateProductBody({ product, config, imageUris: ["tiktok-image-uri"] });
  const plain = JSON.parse(JSON.stringify(body));
  assert.equal(plain.save_mode, "AS_DRAFT");
  assert.equal(plain.category_id, "category-leaf");
  assert.equal(plain.main_images[0].uri, "tiktok-image-uri");
  assert.deepEqual(plain.skus[0], {
    seller_sku: "TAHA-01",
    external_sku_id: "variant-1",
    price: { amount: "399000", currency: "VND" },
    inventory: [{ warehouse_id: "warehouse-1", quantity: 12 }],
  });
});

test("multiple variants require category sales attributes per SKU", async () => {
  const listing = await loadListing();
  const multi = {
    ...product,
    variants: [...product.variants, { id: "variant-2", sku: "TAHA-02", priceMinor: 429000, inventoryQuantity: 5 }],
  };
  const issues = listing.preflightTikTokListing({ product: multi, config, imageUris: ["uri"] });
  assert.equal(issues.filter((issue) => issue.code === "TIKTOK_SALES_ATTRIBUTES_REQUIRED").length, 2);
});
