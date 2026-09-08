import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../lib/ai/shoe-content.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const commonJsModule = { exports: {} };
new vm.Script(compiled, { filename: "shoe-content.cjs" }).runInContext(vm.createContext({ module: commonJsModule, exports: commonJsModule.exports }));
const policy = commonJsModule.exports;

test("the sex-specific size chart preserves every supplied value, including overlaps", () => {
  const rows = (gender) => policy.SHOE_SIZE_CHART[gender].map(({ size, minCm, maxCm }) => `${size}:${minCm}–${maxCm}`).join(";");
  assert.equal(rows("female"), "36:21.6–22.5;37:22.6–23.5;38:23.6–24.1;39:24.2–25.1;40:25.2–25.9;41:26.0–26.7;42:26.8–27.6;43:27.7–28.5;44:28.6–30.0");
  assert.equal(rows("male"), "36:21.6–22.5;37:22.5–22.9;38:23.0–23.8;39:23.9–24.5;40:24.6–25.3;41:25.4–26.1;42:26.2–26.8;43:26.9–27.7;44:27.8–28.5");
});

test("guidance contains both source categories and applies size audience conservatively", () => {
  assert.equal(policy.SHOE_STORAGE_GUIDANCE.length, 6);
  assert.equal(policy.SHOE_CLEANING_GUIDANCE.length, 5);
  assert.equal(policy.shoeSizeAudience({ name: "Giày chạy bộ nữ PH0014" }), "female");
  assert.equal(policy.shoeSizeAudience({ name: "Giày nam PH0014" }), "male");
  assert.equal(policy.shoeSizeAudience({ name: "Giày unisex PH0014" }), "both");
  assert.equal(policy.shoeSizeAudience({ name: "Giày nữ", gender: "unisex" }), "both");
  assert.equal(policy.shoeSizeAudience({ name: "Giày sản xuất tại Việt Nam" }), "both");
  const text = policy.shoeCustomerReferenceText({ name: "LITUO SPORT PH0014", sizes: ["36", "37", "38", "39", "40", "41", "42", "43", "44"] });
  for (const phrase of ["Nữ —", "Nam —", "khăn ẩm", "chất tẩy mạnh", "Không ngâm lâu", "nguồn nhiệt lớn", "nắng gắt", "khô ráo", "xịt bảo vệ"]) {
    assert.ok(text.includes(phrase), phrase);
  }
  assert.equal(policy.hasWaterResistanceClaim(text), false);
});

test("the customer appendix is idempotent and safe to publish", () => {
  const product = { sku: "PH0014", name: "Giày thể thao nam", sizes: ["40", "41", "42"] };
  const once = policy.appendShoeCustomerReference("👟 Cùng PH0014 bước vào ngày mới.", product);
  const twice = policy.appendShoeCustomerReference(once, product);
  assert.equal(once, twice);
  assert.match(once, /Nam — size VN\/EU/);
  assert.doesNotMatch(once, /Nữ — size VN\/EU/);
  assert.doesNotThrow(() => policy.assertCustomerCopyAllowed({ title: "PH0014", body: twice, hashtags: ["#PH0014", "#TAHAShoes"] }));
});

test("prices and pricing calls to action are blocked without rejecting SKU or size measurements", () => {
  const prohibited = [
    "Giá bán: 619.000 VND", "Giá tham khảo: 990.000", "Giá: sáu trăm mười chín nghìn",
    "Giá chỉ 619000", "Giá 619000", "Giá là 619000", "Chỉ 619k", "Chỉ 619 K", "619.000đ", "619000d", "619,000 ₫", "$29.99", "USD 29.99",
    "Sáu trăm mười chín nghìn đồng", "Ưu đãi 20%", "Inbox để nhận báo giá", "#Gia619K", "６１９．０００ VND",
    "619\u200b.000 VND", "Mức niêm yết 990.000", "Giá gốc: 990000",
  ];
  for (const body of prohibited) {
    assert.throws(() => policy.assertCustomerCopyAllowed({ body }), (error) => error.code === "CONTENT_PRICE_FORBIDDEN", body);
  }
  for (const body of [
    "Giày PH0014, chất liệu lưới; bảo hành 12 tháng.",
    "Size 36: 21.6–22.5 cm; size 44: 28.6–30.0 cm.",
    "Mã TAHA-001, màu trắng, số lượng 200 đôi.",
    "100% chất liệu được ghi trên nhãn; 300 g; 20 mm.",
    "Thiết kế 3D, chất liệu lưới, SKU PH0014.",
    policy.shoeCustomerReferenceText(),
  ]) {
    assert.doesNotThrow(() => policy.assertCustomerCopyAllowed({ body }), body);
  }
});

test("post-publication edits use the same forbidden provenance and SKU-warning gate", () => {
  for (const body of [
    "Vui lòng kiểm tra đúng mã sản phẩm PH0014 và thương hiệu LITUO SPORT trước khi mua.",
    "Hãy đối chiếu lại SKU PH0014 trước khi mua.",
    "Hình ảnh sản phẩm sử dụng ảnh có sẵn từ Google Drive.",
    "Thông tin lấy từ Google Sheets", "Ảnh được tạo bằng AI", "Bài viết do AI tạo.",
    "Hệ thống tự động chuẩn bị nội dung", "Nguồn ảnh đã được đối chiếu.",
  ]) {
    assert.throws(() => policy.assertCustomerCopyAllowed({ body }), (error) => error.code === "CONTENT_INTERNAL_TEXT_FORBIDDEN", body);
  }
  assert.doesNotThrow(() => policy.assertCustomerCopyAllowed({ body: "Mã sản phẩm PH0014. Hãy kiểm tra chiều dài chân để chọn size phù hợp." }));
});

test("the 2000-word limit includes title and every hashtag", () => {
  const body = Array(1997).fill("giày").join(" ");
  assert.doesNotThrow(() => policy.assertCustomerCopyAllowed({ title: "Giày đẹp", body, hashtags: ["#PH0014"] }));
  assert.throws(() => policy.assertCustomerCopyAllowed({ title: "Giày đẹp", body, hashtags: ["#PH0014", "#TAHAShoes"] }), (error) => error.code === "CONTENT_WORD_LIMIT_EXCEEDED");
});

test("raw catalog text loses price clauses while retaining source product facts", () => {
  const input = "PH0014; Upper lưới; 619.000 VND; Đế cao su\nGiá tham khảo: 990.000\nBảo hành: 12 tháng. Quà tặng: vớ thể thao\nVui lòng kiểm tra đúng mã sản phẩm PH0014 trước khi mua.";
  const clean = policy.sanitizeProductTextForCopy(input);
  assert.match(clean, /PH0014/);
  assert.match(clean, /Upper lưới/);
  assert.match(clean, /Đế cao su/);
  assert.match(clean, /Bảo hành: 12 tháng/);
  assert.match(clean, /vớ thể thao/);
  assert.doesNotMatch(clean, /619|990|Giá tham khảo|Vui lòng kiểm tra/);
});
