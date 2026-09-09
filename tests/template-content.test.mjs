import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { harness, ROOT } from "./sqlite-harness.mjs";

function loadTemplate() {
  const h = harness();
  h.overrides.delete(path.join(ROOT, "lib/ai/template.ts"));
  return { h, template: h.load("lib/ai/template.ts") };
}

test("approved template writes one canonical SKU article without OpenAI, image generation or price disclosure", async () => {
  const { h, template } = loadTemplate();
  let externalRequests = 0;
  h.runtime.TEST_FETCH = async () => { externalRequests += 1; throw new Error("No external request is allowed"); };
  const result = await template.generateProductContent({
    product: {
      sku: "PH0018",
      name: "Lituo Sport PH0018",
      description: "Sneaker thể thao nhẹ, dễ phối. Giá 490.000đ.",
      brand: "Lituo Sport",
      category: "Sneaker thể thao",
      priceMinor: 490000,
      compareAtPriceMinor: 590000,
      sizes: ["36", "37", "38", "39", "40"],
      colors: ["Trắng kem"],
      specifications: ["Thiết kế năng động", "Phù hợp trang phục casual"],
    },
    targetProviders: ["facebook", "website", "zalo_personal", "shopee", "tiktok_shop"],
  });

  assert.equal(result.model, "taha-approved-template-v3");
  assert.equal(JSON.stringify(result.usage), JSON.stringify({
    source: "approved-template", externalRequests: 0, articleWrites: 1,
    sharedAcrossChannels: ["facebook", "website", "zalo_personal", "shopee", "tiktok_shop"], sourceCorrections: [],
  }));
  assert.equal(externalRequests, 0);
  assert.equal(result.content.sku, "PH0018");
  assert.equal(result.content.channels, undefined);
  assert.equal(result.content.productDescription, undefined);
  assert.equal(result.content.canonicalArticle.version, "sku-canonical-v1");
  assert.match(result.content.canonicalArticle.body, /PH0018/);
  assert.doesNotMatch(`${result.content.canonicalArticle.title}\n${result.content.canonicalArticle.body}\n${result.content.canonicalArticle.hashtags.join(" ")}`, /490[. ]?000|590[. ]?000|₫|\bVND\b/iu);
  assert.match(result.content.canonicalArticle.body, /Thiết kế:[\s\S]*Ưu điểm:[\s\S]*Ứng dụng:/u);
  assert.match(result.content.canonicalArticle.body, /THÔNG TIN LIÊN HỆ/);
  assert.match(result.content.canonicalArticle.body, /Size hiện có: 36, 37, 38, 39, 40/);
});

test("approved template is deterministic for the same exact SKU", async () => {
  const { template } = loadTemplate();
  const input = {
    product: { sku: "PH0021", name: "Lituo Sport PH0021", sizes: ["39", "40"] },
    targetProviders: ["facebook"],
  };
  const first = await template.generateProductContent(input);
  const second = await template.generateProductContent(input);
  assert.deepEqual(first, second);
});

test("approved Facebook template accepts production SEO names with store-policy suffixes", async () => {
  const { template } = loadTemplate();
  const result = await template.generateProductContent({
    product: {
      sku: "PH0022",
      name: "Lituo Sport Giày Chính Hãng SKU - Sneaker Cao Cấp Thoải Mái & Phong Cách - Bảo Hành 12 Tháng - Quà Tặng Khử Mùi & Vớ Thể Thao",
      brand: "Lituo Sport",
      category: "Sneaker cao cấp",
      sizes: ["36", "37", "38", "39", "40", "41", "42", "43"],
    },
    targetProviders: ["facebook"],
  });

  const body = result.content.canonicalArticle.body;
  const productSections = body.split("MUA SẮM CÙNG TAHA SHOES")[0];
  assert.match(productSections, /PH0022/);
  assert.match(productSections, /Thiết kế:[\s\S]*Ưu điểm:[\s\S]*Ứng dụng:/u);
  assert.doesNotMatch(productSections, /bảo\s*hành|quà\s*tặng/iu);
  assert.match(body, /Bảo hành 12 tháng/u);
  assert.match(body, /Quà tặng kèm: khử mùi \+ vớ thể thao/u);
  assert.equal(JSON.stringify(result.content.sourceCorrections), JSON.stringify(["sku_editorial_name_normalized"]));
});

test("canonical SKU template repairs malformed Sheet display text for any channel without a manual retry", async () => {
  const { template } = loadTemplate();
  const result = await template.generateProductContent({
    product: {
      sku: "PH0099",
      name: "Hotline: 0765.109.784 - Quà tặng - Bảo hành",
      brand: "",
      category: "",
      sizes: ["39", "40"],
    },
    targetProviders: ["shopee"],
  });

  const body = result.content.canonicalArticle.body;
  assert.match(body, /Mẫu giày PH0099/u);
  assert.match(body, /Thiết kế:[\s\S]*Ưu điểm:[\s\S]*Ứng dụng:/u);
  assert.equal(JSON.stringify(result.content.sourceCorrections), JSON.stringify([
    "sku_editorial_name_normalized",
    "canonical_structure_fallback",
  ]));
});
