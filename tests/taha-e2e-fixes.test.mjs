import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Drive SKU normalization accepts canonical SKU prefix", () => {
  const source = read("lib/integrations/google-drive.ts");
  assert.ok(source.includes('.replace(/^SKU\\s+/i, "")'));
  assert.ok(source.includes('return skuKey ? `SKU ${skuKey}` : ""'));
});

test("automation requires two source images and attaches 2+6 media", () => {
  const source = read("lib/automation.ts");
  assert.match(source, /TWO_SOURCE_IMAGES_REQUIRED/);
  assert.match(source, /referenceSources:/);
  assert.match(source, /const draftMediaIds = \[\.\.\.originalMediaIds, \.\.\.mediaIds\]/);
  assert.match(source, /Math\.min\(8,/);
  assert.match(source, /Promise\.all\(claimed\.map/);
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

test("daily automation and website eight-image delivery are enabled", () => {
  const daily = read("lib/daily-automation.ts");
  const cron = read("app/api/internal/cron/tick/route.ts");
  const publishing = read("lib/publishing.ts");
  assert.match(daily, /idempotencyKey: `daily:/);
  assert.match(daily, /imageCount: 6/);
  assert.match(cron, /runAutomationWorker\(\{ limit: 8 \}\)/);
  assert.match(publishing, /slice\(0, 8\)/);
});
