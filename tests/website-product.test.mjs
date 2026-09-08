import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

async function loadWebsiteProduct() {
  const source = await readFile(new URL("../lib/website-product.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const commonJsModule = { exports: {} };
  const context = vm.createContext({ module: commonJsModule, exports: commonJsModule.exports, console });
  new vm.Script(compiled, { filename: "website-product.cjs" }).runInContext(context);
  return commonJsModule.exports;
}

function sourceProduct(metadata = { sizes: ["36", "37"] }) {
  return {
    id: "product-1",
    base_sku: "PH0014",
    name: "Giày chạy bộ PH0014",
    description: "Mô tả Sheet",
    brand: "LITUO SPORT",
    category: "Giày chạy bộ",
    currency: "VND",
    price_minor: 619_000,
    compare_at_price_minor: 990_000,
    inventory_quantity: 12,
    source_connection_id: "google-1",
    metadata_json: JSON.stringify({ website: metadata }),
  };
}

function media(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    filename: `PH0014-${index + 1}.jpg`, mimeType: "image/jpeg", dataBase64: "AA==",
  }));
}

test("builds a six-image idempotent product upsert matching the TAHA Shoes fields", async () => {
  const { buildWebsiteProductPayload, WEBSITE_PRODUCT_SCHEMA_VERSION } = await loadWebsiteProduct();
  const payload = buildWebsiteProductPayload({
    jobId: "job-1",
    idempotencyKey: "schedule:website:1",
    product: sourceProduct({
      subcategory: "Running", colors: ["Trắng", "Xám"], gifts: ["Đôi vớ"], sizes: ["36", "37"],
      costPriceMinor: 250_000, rating: 5, reviewCount: 98, soldCount: 123,
      specifications: ["Chất liệu: mesh", "Đế: cao su"],
    }),
    draft: {
      id: "draft-1", version: 2, title: "Giày Running Linh Hoạt Lituo Sport - PH0014",
      body: "Thông tin sản phẩm\n• Thân giày thoáng nhẹ\n• Đệm êm hỗ trợ di chuyển\n📏 CHỌN SIZE",
      hashtags: ["#PH0014", "#LituoSport"], platformData: {},
    },
    media: media(6),
  });
  const plain = JSON.parse(JSON.stringify(payload));
  assert.equal(plain.schemaVersion, WEBSITE_PRODUCT_SCHEMA_VERSION);
  assert.equal(plain.operation, "upsert_product");
  assert.equal(plain.product.sku, "PH0014");
  assert.equal(plain.product.media.length, 6);
  assert.equal(plain.product.media[0].role, "primary");
  assert.equal(plain.product.media[5].role, "gallery");
  assert.deepEqual({ rating: plain.product.rating, reviewCount: plain.product.reviewCount, soldCount: plain.product.soldCount }, { rating: 5, reviewCount: 98, soldCount: 123 });
  assert.equal(plain.product.price, 619_000);
  assert.equal(plain.product.originalPrice, 990_000);
  assert.equal(plain.product.discount, 37);
  assert.equal(plain.product.shortDescription, "• Thông tin sản phẩm\n• Thân giày thoáng nhẹ\n• Đệm êm hỗ trợ di chuyển");
  assert.deepEqual(plain.product.specifications, { "Chất liệu": "mesh", "Đế": "cao su" });
});

test("omits absent review and sales counters so an upsert cannot fabricate social proof", async () => {
  const { buildWebsiteProductPayload } = await loadWebsiteProduct();
  const payload = buildWebsiteProductPayload({
    jobId: "job-2", idempotencyKey: "schedule:website:2", product: sourceProduct(),
    draft: { id: "draft-2", version: 1, body: "Mô tả chi tiết PH0014", hashtags: [] }, media: media(1),
  });
  assert.equal(Object.hasOwn(payload.product, "rating"), false);
  assert.equal(Object.hasOwn(payload.product, "reviewCount"), false);
  assert.equal(Object.hasOwn(payload.product, "soldCount"), false);
});

test("adds the exact SKU to the title and rejects products without an explicit size list", async () => {
  const { buildWebsiteProductPayload } = await loadWebsiteProduct();
  const payload = buildWebsiteProductPayload({
    jobId: "job-3", idempotencyKey: "schedule:website:3", product: sourceProduct({ sizes: ["39", "40"] }),
    draft: { id: "draft-3", version: 1, title: "Giày chạy bộ linh hoạt", body: "Mô tả riêng" }, media: media(1),
  });
  assert.equal(payload.product.name, "Giày chạy bộ linh hoạt - PH0014");
  assert.deepEqual(JSON.parse(JSON.stringify(payload.product.sizes)), ["39", "40"]);
  assert.throws(() => buildWebsiteProductPayload({
    jobId: "job-4", idempotencyKey: "schedule:website:4", product: sourceProduct({}),
    draft: { id: "draft-4", version: 1, body: "Mô tả" }, media: media(1),
  }), /WEBSITE_PRODUCT_SIZES_REQUIRED/);
});

test("keeps every source photo and rejects an empty gallery", async () => {
  const { buildWebsiteProductPayload } = await loadWebsiteProduct();
  const base = { jobId: "job", idempotencyKey: "key", product: sourceProduct(), draft: { id: "draft", version: 1, body: "Mô tả" } };
  assert.throws(() => buildWebsiteProductPayload({ ...base, media: [] }), /WEBSITE_PRODUCT_MEDIA_COUNT_INVALID/);
  assert.equal(buildWebsiteProductPayload({ ...base, media: media(27) }).product.media.length, 27);
});
