import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./sqlite-harness.mjs";

test("admin edits cannot reintroduce prices, internal provenance, or oversized posts", async () => {
  const h = harness();
  const review = h.load("lib/content-review.ts").reviewContentDraft;
  for (const [body, code] of [
    ["PH0014 Giá bán: 619.000 VND", "CONTENT_PRICE_FORBIDDEN"],
    ["PH0014 Giá chỉ : 6xx", "CONTENT_PRICE_FORBIDDEN"],
    ["PH0014 Ảnh có sẵn từ Google Drive", "CONTENT_INTERNAL_TEXT_FORBIDDEN"],
    ["giày ".repeat(2001), "CONTENT_WORD_LIMIT_EXCEEDED"],
  ]) {
    await assert.rejects(review("draft", { action: "edit", version: 1, title: "PH0014", body, hashtags: ["PH0014"] }, "admin"), (error) => error.code === code && error.status === 422);
  }
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n, 0);
});
