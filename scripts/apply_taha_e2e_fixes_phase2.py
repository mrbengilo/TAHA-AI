from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(rel, old, new):
    path = ROOT / rel
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{rel}: expected 1 match, found {count}: {old[:120]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


# Existing queue contract mock now reflects the new production invariant: two original product images.
replace_once(
    "tests/automation-contract.test.mjs",
    '''  async all() {
    return { results: [] };
  }''',
    '''  async all() {
    const q = this.query;
    if (q.includes("SELECT m.id FROM product_media") && q.includes("m.origin = 'source'")) {
      return { results: [{ id: "media-source-1" }, { id: "media-source-2" }] };
    }
    return { results: [] };
  }''',
)

# Publishing deadlines must remain ahead of long-running image generation.
cron = ROOT / "app/api/internal/cron/tick/route.ts"
cron.write_text('''import { fail, ok } from "../../../../../lib/api";
import { runAutomationWorker } from "../../../../../lib/automation";
import { ensureDailyProductAutomation } from "../../../../../lib/daily-automation";
import { runPublishDispatcher } from "../../../../../lib/dispatcher";
import { getRuntimeEnv } from "../../../../../lib/integrations/env";
import { runSchedulerTick } from "../../../../../lib/scheduler";

export const dynamic = "force-dynamic";

async function constantTimeEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

export async function POST(request: Request) {
  const secret = getRuntimeEnv().INTERNAL_API_SECRET;
  if (!secret) return fail("CRON_NOT_CONFIGURED", "Lịch chạy nền chưa được cấu hình trên máy chủ.", 503);
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!provided || !(await constantTimeEqual(provided, secret))) return fail("UNAUTHORIZED", "Yêu cầu lịch chạy nền không hợp lệ.", 401);

  try {
    // Deadlines first: enqueue and dispatch content that is already due before doing expensive AI image work.
    const scheduler = await runSchedulerTick();
    const dispatcher = await runPublishDispatcher();

    let daily: Awaited<ReturnType<typeof ensureDailyProductAutomation>> | { queued: false; reason: string };
    try {
      daily = await ensureDailyProductAutomation();
    } catch {
      daily = { queued: false, reason: "daily_planning_failed" };
    }

    let automation: Awaited<ReturnType<typeof runAutomationWorker>> | { errorCode: string };
    try {
      automation = await runAutomationWorker({ limit: 8 });
    } catch {
      automation = { errorCode: "AUTOMATION_TICK_FAILED" };
    }

    return ok({ daily, automation, scheduler, dispatcher }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "CRON_TICK_FAILED";
    if (code === "DATABASE_UNAVAILABLE") return fail(code, "Cơ sở dữ liệu lịch chạy nền chưa sẵn sàng.", 503);
    return fail("CRON_TICK_FAILED", "Không thể xử lý công việc nền lúc này.", 500);
  }
}
''', encoding="utf-8")

# Recreate the static contract test with robust string assertions.
test = ROOT / "tests/taha-e2e-fixes.test.mjs"
test.write_text(r'''import test from "node:test";
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
''', encoding="utf-8")

print("TAHA phase-2 compatibility fixes applied")
