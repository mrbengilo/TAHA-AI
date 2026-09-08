import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Drive SKU normalization accepts canonical SKU prefix", () => {
  const source = read("lib/integrations/google-drive.ts");
  assert.ok(source.includes('.replace(/^SKU\\s+/i, "")'));
  assert.ok(source.includes('return skuKey ? `SKU ${skuKey}` : ""'));
});

test("channel UI renders real image previews", () => {
  const library = read("lib/channel-library.ts");
  const ui = read("app/channels/[provider]/ChannelWorkspace.tsx");
  const mediaRoute = read("app/api/media/[id]/download/route.ts");
  assert.match(library, /previewUrl:/);
  assert.match(ui, /className="ch-media-preview"/);
  assert.match(ui, /src=\{item\.previewUrl\}/);
  assert.match(mediaRoute, /searchParams\.get\("inline"\)/);
});

test("daily automation uses Drive originals for Facebook while website delivery remains immediate", () => {
  const daily = read("lib/daily-automation.ts");
  const cron = read("app/api/internal/cron/tick/route.ts");
  assert.match(daily, /idempotencyKey: `daily:/);
  assert.doesNotMatch(daily, /imageCount:\s*[1-9]/);
  assert.match(daily, /targetProviders: \["facebook"\]/);
  assert.match(cron, /ensureDailyGoogleCatalogRefresh/);
  assert.match(cron, /runAutomationWorker\(\{ limit: 1 \}\)/);
  const automation = read("lib/automation.ts");
  assert.doesNotMatch(automation, /editProductImage|plannedGeneratedImageCount|MAX_POST_IMAGES/);
  assert.match(automation, /const selectedSourceMediaIds = originalMediaIds/);
  assert.match(automation, /publicationDayFromRequestKey/);
  assert.match(automation, /nextLocalSlot\(now, scheduleHour, current\.request_key\)/);
  assert.match(automation, /const runAt = provider === "website" \? now/);
  assert.match(automation, /provider === "facebook" && scheduledFor !== null/);
  assert.match(automation, /\? scheduledFor/);
});

test("website publishing uses a versioned SKU upsert with every source image", () => {
  const publishing = read("lib/publishing.ts");
  const contract = read("lib/website-product.ts");
  assert.match(publishing, /buildWebsiteProductPayload/);
  assert.match(contract, /taha\.website\.product\.v1/);
  assert.doesNotMatch(contract, /WEBSITE_PRODUCT_MAX_IMAGES|slice\(0,\s*6\)/);
  assert.match(contract, /operation: "upsert_product"/);
});

test("product tables expose real primary-image thumbnails", () => {
  const library = read("lib/channel-library.ts");
  const ui = read("app/channels/[provider]/ChannelWorkspace.tsx");
  assert.match(library, /primary_media_id/);
  assert.match(library, /previewUrl:/);
  assert.match(ui, /ch-product-thumb/);
  assert.match(ui, /product\.previewUrl/);
});

test("channel selectors use each platform's brand color", () => {
  const ui = read("app/automation/AutomationCenter.tsx");
  const css = read("app/automation/automation.css");
  assert.match(ui, /data-provider=\{provider\.id\}/);
  assert.match(css, /data-provider="facebook"/);
  assert.match(css, /#1877f2/);
  assert.match(css, /data-provider="zalo_personal"/);
  assert.match(css, /#0068ff/);
  assert.match(css, /data-provider="website"/);
  assert.match(css, /data-provider="tiktok_shop"/);
  assert.match(css, /#25f4ee/);
  assert.match(css, /#fe2c55/);
  assert.match(css, /data-provider="shopee"/);
  assert.match(css, /#ee4d2d/);
});

test("Facebook repost controls remain visible before any post is eligible", () => {
  const ui = read("app/automation/FacebookSchedulingPanel.tsx");
  assert.match(ui, /<option value="">Chưa có sản phẩm đủ điều kiện<\/option>/);
  assert.match(ui, /className="facebook-primary-button is-repost"/);
  assert.match(ui, /"Đăng lại theo lịch"/);
  assert.doesNotMatch(ui, /\{products\.length \? <>/);
});
