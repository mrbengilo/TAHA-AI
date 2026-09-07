import assert from "node:assert/strict";
import test from "node:test";
import { cleanTrialCopy, checkTarget, TARGET } from "../deploy/vps/facebook-trial-correct.mjs";

const before = "Giày PH0014\n• Giá bán: 619.000 VND\n• Giá tham khảo: 990.000 VND\n• Bảo hành: 12 tháng\n• Size 36: 21.6 - 22.5 cm\n\nVui lòng kiểm tra đúng mã sản phẩm PH0014 và thương hiệu LITUO SPORT trước khi mua. Hình ảnh sản phẩm sử dụng ảnh có sẵn từ Google Drive.\n\n#PH0014";
test("correction removes only requested prices and internal paragraph, preserving SKU, measurements and hashtags", () => {
  const after = cleanTrialCopy(before);
  assert.equal(after, "Giày PH0014\n• Bảo hành: 12 tháng\n• Size 36: 21.6 - 22.5 cm\n\n#PH0014");
  assert.equal(cleanTrialCopy(after), after);
  assert.equal(cleanTrialCopy(before.replace('• Giá bán: 619.000 VND', '• Giá chỉ : 6xx')), after);
  assert.throws(() => cleanTrialCopy("PH0014 619.000 VND"), /STILL_INVALID/);
});
test("correction cannot edit another Page, job, SKU, unpublished job or human-changed draft", () => {
  const payload = { productId: TARGET.productId, draftId: "draft", provider: "facebook", message: before, hashtags: ["PH0014"] };
  const row = { id: TARGET.jobId, workspace_id: TARGET.workspaceId, product_id: TARGET.productId,
    status: "published", external_post_id: TARGET.postId, page_id: TARGET.pageId, provider: "facebook",
    connection_status: "connected", draft_product_id: TARGET.productId, target_provider: "facebook", draft_id: "draft",
    payload_snapshot_json: JSON.stringify(payload), body: before, hashtags_json: '["PH0014"]' };
  assert.doesNotThrow(() => checkTarget(row));
  for (const patch of [{ id: "other" }, { page_id: "other" }, { external_post_id: "other" }, { status: "failed" },
    { product_id: "other" }, { body: "Human edit PH0014" }]) assert.throws(() => checkTarget({ ...row, ...patch }));
});
