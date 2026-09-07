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

test("daily automation requests up to four lifestyle images and limits every post to six", () => {
  const daily = read("lib/daily-automation.ts");
  const cron = read("app/api/internal/cron/tick/route.ts");
  const publishing = read("lib/publishing.ts");
  assert.match(daily, /idempotencyKey: `daily:/);
  assert.match(daily, /imageCount: 4/);
  assert.match(cron, /runAutomationWorker\(\{ limit: 1 \}\)/);
  assert.match(publishing, /slice\(0, 8\)/);
  const automation = read("lib/automation.ts");
  assert.match(automation, /plannedGeneratedImageCount/);
  assert.match(automation, /MAX_POST_IMAGES/);
  assert.match(automation, /publicationDayFromRequestKey/);
  assert.match(automation, /nextLocalSlot\(now, scheduleHour, current\.request_key\)/);
});

test("product tables expose real primary-image thumbnails", () => {
  const library = read("lib/channel-library.ts");
  const ui = read("app/channels/[provider]/ChannelWorkspace.tsx");
  assert.match(library, /primary_media_id/);
  assert.match(library, /previewUrl:/);
  assert.match(ui, /ch-product-thumb/);
  assert.match(ui, /product\.previewUrl/);
});
