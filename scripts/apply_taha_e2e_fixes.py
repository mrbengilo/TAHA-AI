from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(rel, old, new):
    path = ROOT / rel
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{rel}: expected 1 match, found {count}: {old[:120]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def append_once(rel, marker, block):
    path = ROOT / rel
    text = path.read_text(encoding="utf-8")
    if marker in text:
        return
    path.write_text(text.rstrip() + "\n\n" + block.strip() + "\n", encoding="utf-8")


# 1) Canonical SKU mapping: Sheet PH0006 <-> Drive "SKU PH0006".
replace_once(
    "lib/integrations/google-drive.ts",
    '''export function normalizeSkuKey(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\\s+/g, " ")
    .trim()
    .toUpperCase();
}''',
    '''export function normalizeSkuKey(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\\s+/g, " ")
    .trim()
    .replace(/^SKU\\s+/i, "")
    .toUpperCase();
}

export function canonicalGoogleDriveSkuFolderName(value: unknown) {
  const skuKey = normalizeSkuKey(value);
  return skuKey ? `SKU ${skuKey}` : "";
}''',
)

# 2) OpenAI image edits accept two product reference images.
replace_once(
    "lib/ai/openai.ts",
    '''export type EditProductImageInput = {
  source: Blob;
  filename: string;
  mimeType: string;
  product: { sku: string; name: string };
  layoutIndex: number;
};''',
    '''export type EditProductImageInput = {
  source: Blob;
  filename: string;
  mimeType: string;
  referenceSources?: Array<{ source: Blob; filename: string; mimeType: string }>;
  product: { sku: string; name: string };
  layoutIndex: number;
};''',
)
replace_once(
    "lib/ai/openai.ts",
    '''  const sku = requiredString(input.product?.sku, 128, "OPENAI_IMAGE_INPUT_INVALID");''',
    '''  const referenceSources = (input.referenceSources ?? []).slice(0, 1);
  for (const reference of referenceSources) {
    const referenceMimeType = typeof reference.mimeType === "string" ? reference.mimeType.trim().toLowerCase() : "";
    if (!(reference.source instanceof Blob)
      || reference.source.size <= 0
      || reference.source.size > MAX_SOURCE_IMAGE_BYTES
      || !SUPPORTED_IMAGE_MIME_TYPES.has(referenceMimeType)
      || (reference.source.type && reference.source.type.toLowerCase() !== referenceMimeType)) {
      throw new OpenAiClientError("OPENAI_IMAGE_INPUT_INVALID");
    }
  }
  const sku = requiredString(input.product?.sku, 128, "OPENAI_IMAGE_INPUT_INVALID");''',
)
replace_once(
    "lib/ai/openai.ts",
    '''  form.append("image[]", input.source, safeFilename(filename));''',
    '''  form.append("image[]", input.source, safeFilename(filename));
  for (const reference of referenceSources) {
    form.append("image[]", reference.source, safeFilename(reference.filename));
  }''',
)
replace_once(
    "lib/ai/openai.ts",
    '''    "Nếu không chắc về một chi tiết sản phẩm, phải giữ nguyên chi tiết trong ảnh nguồn.",''',
    '''    "Nếu có hai ảnh nguồn, phải đối chiếu cả hai để giữ chính xác hình dáng, logo, vật liệu, màu sắc, đế, gót và các chi tiết nhận diện ở nhiều góc nhìn.",
    "Nếu không chắc về một chi tiết sản phẩm, phải giữ nguyên chi tiết trong ảnh nguồn.",''',
)

# 3) Require/use two original images for automation; attach 2 originals + 6 generated to each draft.
replace_once(
    "lib/automation.ts",
    '''async function sourceMediaId(db: AutomationDatabase, productId: string, requested: string | null) {
  const row = requested
    ? await db.prepare(
      `SELECT m.id FROM media_assets m JOIN product_media pm ON pm.media_id = m.id
       WHERE m.id = ? AND pm.product_id = ? AND m.workspace_id = ? AND m.media_type = 'image' AND m.status = 'ready' LIMIT 1`,
    ).bind(requested, productId, TAHA_WORKSPACE_ID).first<{ id: string }>()
    : await db.prepare(
      `SELECT m.id FROM product_media pm JOIN media_assets m ON m.id = pm.media_id
       WHERE pm.product_id = ? AND pm.workspace_id = ? AND m.media_type = 'image' AND m.status = 'ready'
       ORDER BY CASE pm.role WHEN 'primary' THEN 0 WHEN 'source' THEN 1 ELSE 2 END, pm.sort_order, pm.created_at LIMIT 1`,
    ).bind(productId, TAHA_WORKSPACE_ID).first<{ id: string }>();
  if (!row) throw new AutomationError("SOURCE_IMAGE_REQUIRED", "Sản phẩm chưa có ảnh gốc hợp lệ.", 409);
  return row.id;
}''',
    '''async function originalMediaIdsForProduct(db: AutomationDatabase, productId: string, limit = 2) {
  const rows = await db.prepare(
    `SELECT m.id FROM product_media pm JOIN media_assets m ON m.id = pm.media_id
     WHERE pm.product_id = ? AND pm.workspace_id = ? AND m.media_type = 'image'
       AND m.status = 'ready' AND m.origin = 'source'
     ORDER BY CASE pm.role WHEN 'primary' THEN 0 WHEN 'source' THEN 1 ELSE 2 END,
              pm.sort_order, pm.created_at LIMIT ?`,
  ).bind(productId, TAHA_WORKSPACE_ID, limit).all<{ id: string }>();
  return (rows.results ?? []).map((row) => row.id);
}

async function sourceMediaId(db: AutomationDatabase, productId: string, requested: string | null) {
  const originals = await originalMediaIdsForProduct(db, productId, 2);
  if (originals.length < 2) {
    throw new AutomationError(
      "TWO_SOURCE_IMAGES_REQUIRED",
      "Sản phẩm cần ít nhất 2 ảnh gốc trong đúng thư mục SKU trên Google Drive trước khi chạy AI.",
      409,
    );
  }
  if (!requested) return originals[0];
  const row = await db.prepare(
    `SELECT m.id FROM media_assets m JOIN product_media pm ON pm.media_id = m.id
     WHERE m.id = ? AND pm.product_id = ? AND m.workspace_id = ? AND m.media_type = 'image'
       AND m.status = 'ready' AND m.origin = 'source' LIMIT 1`,
  ).bind(requested, productId, TAHA_WORKSPACE_ID).first<{ id: string }>();
  if (!row) throw new AutomationError("SOURCE_IMAGE_REQUIRED", "Ảnh nguồn đã chọn không phải ảnh gốc hợp lệ của sản phẩm.", 409);
  return row.id;
}''',
)
replace_once(
    "lib/automation.ts",
    '''  const source = await mediaBlob(run.source_media_id, 20 * 1024 * 1024);
  const edited = await editProductImage({
    source: source.blob,
    filename: source.filename,
    mimeType: source.mimeType,
    product: { sku: product.base_sku, name: product.name },
    layoutIndex: step.ordinal,
  });''',
    '''  const referenceIds = await originalMediaIdsForProduct(db, run.product_id, 2);
  if (referenceIds.length < 2) throw new AutomationError("TWO_SOURCE_IMAGES_REQUIRED", "Sản phẩm cần đủ 2 ảnh gốc trước khi tạo ảnh AI.", 409);
  const [source, secondSource] = await Promise.all(referenceIds.map((id) => mediaBlob(id, 20 * 1024 * 1024)));
  const edited = await editProductImage({
    source: source.blob,
    filename: source.filename,
    mimeType: source.mimeType,
    referenceSources: [{ source: secondSource.blob, filename: secondSource.filename, mimeType: secondSource.mimeType }],
    product: { sku: product.base_sku, name: product.name },
    layoutIndex: step.ordinal,
  });''',
)
replace_once(
    "lib/automation.ts",
    '''  const finalizedAt = Date.now();
  const statements: AutomationStatement[] = [];''',
    '''  const originalMediaIds = await originalMediaIdsForProduct(db, run.product_id, 2);
  if (originalMediaIds.length < 2) throw new Error("TWO_SOURCE_IMAGES_REQUIRED");
  const draftMediaIds = [...originalMediaIds, ...mediaIds];
  const finalizedAt = Date.now();
  const statements: AutomationStatement[] = [];''',
)
replace_once(
    "lib/automation.ts",
    '''      generatedImageCount: mediaIds.length,
    };''',
    '''      sourceImageCount: originalMediaIds.length,
      generatedImageCount: mediaIds.length,
      totalImageCount: draftMediaIds.length,
    };''',
)
replace_once(
    "lib/automation.ts",
    '''      JSON.stringify({ automationRunId: run.id, sourceMediaId: run.source_media_id, outputMediaIds: mediaIds }),''',
    '''      JSON.stringify({ automationRunId: run.id, sourceMediaIds: originalMediaIds, outputMediaIds: mediaIds, allMediaIds: draftMediaIds }),''',
)
replace_once(
    "lib/automation.ts",
    '''    for (let index = 0; index < mediaIds.length; index += 1) {''',
    '''    for (let index = 0; index < draftMediaIds.length; index += 1) {''',
)
replace_once(
    "lib/automation.ts",
    '''        await stableId("cdm", `${draftId}:${mediaIds[index]}`),
        TAHA_WORKSPACE_ID,
        draftId,
        mediaIds[index],
        index === 0 ? "primary" : "attachment",''',
    '''        await stableId("cdm", `${draftId}:${draftMediaIds[index]}`),
        TAHA_WORKSPACE_ID,
        draftId,
        draftMediaIds[index],
        index === 0 ? "primary" : index < originalMediaIds.length ? "source" : "attachment",''',
)
# Increase worker capacity and process claimed independent steps concurrently.
replace_once(
    "lib/automation.ts",
    '''  const limit = Math.max(1, Math.min(3, Math.floor(options.limit ?? 1)));''',
    '''  const limit = Math.max(1, Math.min(8, Math.floor(options.limit ?? 4)));''',
)
old_worker = '''  for (const step of candidates.results ?? []) {
    if (summary.leased >= limit) break;
    summary.checked += 1;
    if (step.step_type === "finalize") {
      const pending = await db.prepare(
        `SELECT COUNT(*) AS total FROM automation_steps WHERE run_id = ? AND workspace_id = ?
         AND step_type IN ('content', 'image') AND status != 'completed'`,
      ).bind(step.run_id, TAHA_WORKSPACE_ID).first<{ total: number }>();
      if (Number(pending?.total ?? 0) > 0) {
        summary.skipped += 1;
        continue;
      }
    }
    const lease = await claimStep(db, step, workerId, now);
    if (!lease) {
      summary.skipped += 1;
      continue;
    }
    summary.leased += 1;
    try {
      const run = await loadRun(db, step.run_id);
      if (step.step_type === "content") await processContent(db, run, step, workerId, now);
      else if (step.step_type === "image") await processImage(db, run, step, workerId);
      else await processFinalize(db, run, step, workerId, now);
      summary.completed += 1;
    } catch (error) {
      const transition = await retryOrFail(db, step, lease, workerId, error, Date.now());
      summary[transition.state] += 1;
      summary.errors.push({ stepId: step.id, code: transition.code });
    }
  }
  return summary;'''
new_worker = '''  const claimed: Array<{ step: StepRow; lease: { attempt_count: number; max_attempts: number } }> = [];
  for (const step of candidates.results ?? []) {
    if (claimed.length >= limit) break;
    summary.checked += 1;
    if (step.step_type === "finalize") {
      const pending = await db.prepare(
        `SELECT COUNT(*) AS total FROM automation_steps WHERE run_id = ? AND workspace_id = ?
         AND step_type IN ('content', 'image') AND status != 'completed'`,
      ).bind(step.run_id, TAHA_WORKSPACE_ID).first<{ total: number }>();
      if (Number(pending?.total ?? 0) > 0) {
        summary.skipped += 1;
        continue;
      }
    }
    const lease = await claimStep(db, step, `${workerId}:${step.id}`, now);
    if (!lease) {
      summary.skipped += 1;
      continue;
    }
    claimed.push({ step, lease });
    summary.leased += 1;
  }
  await Promise.all(claimed.map(async ({ step, lease }) => {
    const stepWorkerId = `${workerId}:${step.id}`;
    try {
      const run = await loadRun(db, step.run_id);
      if (step.step_type === "content") await processContent(db, run, step, stepWorkerId, now);
      else if (step.step_type === "image") await processImage(db, run, step, stepWorkerId);
      else await processFinalize(db, run, step, stepWorkerId, now);
      summary.completed += 1;
    } catch (error) {
      const transition = await retryOrFail(db, step, lease, stepWorkerId, error, Date.now());
      summary[transition.state] += 1;
      summary.errors.push({ stepId: step.id, code: transition.code });
    }
  }));
  return summary;'''
replace_once("lib/automation.ts", old_worker, new_worker)

# 4) Real media previews in channel library/UI.
replace_once(
    "lib/channel-library.ts",
    '''      downloadUrl: `/api/media/${encodeURIComponent(String(row.id))}/download`,''',
    '''      previewUrl: `/api/media/${encodeURIComponent(String(row.id))}/download?inline=1`,
      downloadUrl: `/api/media/${encodeURIComponent(String(row.id))}/download`,''',
)
replace_once(
    "app/channels/[provider]/ChannelWorkspace.tsx",
    '''  downloadUrl: string;
};''',
    '''  previewUrl: string;
  downloadUrl: string;
};''',
)
replace_once(
    "app/channels/[provider]/ChannelWorkspace.tsx",
    '''                          <span className="ch-source-thumb"><i>{item.filename.split(".").pop()?.toUpperCase() || "ẢNH"}</i><b>{selected ? "✓" : "+"}</b></span>''',
    '''                          <span className="ch-source-thumb"><img src={item.previewUrl} alt={item.altText || item.filename} loading="lazy" /><b>{selected ? "✓" : "+"}</b></span>''',
)
replace_once(
    "app/channels/[provider]/ChannelWorkspace.tsx",
    '''                      <div className={`ch-media-placeholder is-${item.mediaType}`}><span>{item.mediaType === "video" ? "VIDEO" : item.filename.split(".").pop()?.toUpperCase() || "ẢNH"}</span></div>''',
    '''                      {item.mediaType === "image"
                        ? <img className="ch-media-preview" src={item.previewUrl} alt={item.altText || item.filename} loading="lazy" />
                        : <div className={`ch-media-placeholder is-${item.mediaType}`}><span>VIDEO</span></div>}''',
)
append_once(
    "app/channels/channels.css",
    ".ch-media-preview{",
    '''.ch-media-preview{
  display:block;
  width:100%;
  aspect-ratio:1/1;
  object-fit:cover;
  background:#f3f4f6;
}
.ch-source-thumb img{
  position:absolute;
  inset:0;
  width:100%;
  height:100%;
  object-fit:cover;
}
.ch-source-thumb{position:relative;overflow:hidden;}
.ch-source-thumb b{position:relative;z-index:2;}
''',
)

# Inline mode for thumbnail requests; download remains attachment by default.
path = ROOT / "app/api/media/[id]/download/route.ts"
path.write_text('''import { fail } from "../../../../../lib/api";
import { isViewerRequest } from "../../../../../lib/operator-auth";
import { loadMedia } from "../../../../../lib/media";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isViewerRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để tải ảnh.", 401);
  try {
    const { id } = await context.params;
    const media = await loadMedia(id);
    const inline = new URL(request.url).searchParams.get("inline") === "1";
    return new Response(media.body, {
      headers: {
        "content-type": media.mimeType,
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(media.filename)}`,
        "cache-control": inline ? "private, max-age=300" : "private, no-store",
        "x-content-type-options": "nosniff",
        ...(media.size ? { "content-length": String(media.size) } : {}),
      },
    });
  } catch {
    return fail("MEDIA_NOT_FOUND", "Không tìm thấy ảnh hoặc tài khoản nguồn cần kết nối lại.", 404);
  }
}
''', encoding="utf-8")

# 5) Website may receive all 8 product images.
replace_once(
    "lib/publishing.ts",
    '''    ? input.payload.mediaIds.filter((value): value is string => typeof value === "string").slice(0, 4)''',
    '''    ? input.payload.mediaIds.filter((value): value is string => typeof value === "string").slice(0, 8)''',
)

# 6) Daily automatic product selection: sync Google, select next SKU, queue AI once per publication day.
daily = ROOT / "lib/daily-automation.ts"
daily.write_text('''import { queueAutomationRun } from "./automation";
import { getRuntimeEnv } from "./integrations/env";
import { syncGoogleCatalog } from "./integrations/google-sync";
import { TAHA_WORKSPACE_ID } from "./integrations/store";

const DAY_MS = 24 * 60 * 60 * 1000;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const TARGETS = ["facebook", "zalo_personal", "website"] as const;

type Target = (typeof TARGETS)[number];

type Statement = {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results?: T[] }>;
};

function db() {
  const value = getRuntimeEnv().DB as unknown as { prepare(query: string): Statement } | undefined;
  if (!value) throw new Error("DATABASE_UNAVAILABLE");
  return value;
}

function publicationDay(now: number) {
  const local = new Date(now + VN_OFFSET_MS);
  const afterPreparationWindow = local.getUTCHours() >= 6;
  const target = new Date(local.getTime() + (afterPreparationWindow ? DAY_MS : 0));
  const y = target.getUTCFullYear();
  const m = String(target.getUTCMonth() + 1).padStart(2, "0");
  const d = String(target.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function ensureDailyProductAutomation(now = Date.now()) {
  const database = db();
  const day = publicationDay(now);
  const requestPrefix = `daily:${day}:%`;
  const existing = await database.prepare(
    `SELECT id, status FROM automation_runs
     WHERE workspace_id = ? AND request_key LIKE ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID, requestPrefix).first<{ id: string; status: string }>();
  if (existing) return { queued: false, day, reason: "already_planned", runId: existing.id };

  const google = await database.prepare(
    `SELECT id, last_synced_at FROM channel_connections
     WHERE workspace_id = ? AND provider = 'google' AND status = 'connected'
     ORDER BY updated_at DESC LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID).first<{ id: string; last_synced_at: number | null }>();
  if (!google) return { queued: false, day, reason: "google_not_connected" };
  if (!google.last_synced_at || now - google.last_synced_at > 6 * 60 * 60 * 1000) {
    await syncGoogleCatalog(google.id);
  }

  const connections = await database.prepare(
    `SELECT provider FROM channel_connections
     WHERE workspace_id = ? AND status = 'connected'
       AND provider IN ('facebook', 'zalo_personal', 'website')`,
  ).bind(TAHA_WORKSPACE_ID).all<{ provider: string }>();
  const connected = new Set((connections.results ?? []).map((row) => row.provider));
  const targets = TARGETS.filter((provider) => connected.has(provider)) as Target[];
  if (!targets.length) return { queued: false, day, reason: "no_publish_channels" };

  const product = await database.prepare(
    `SELECT p.id, p.base_sku
     FROM products p
     WHERE p.workspace_id = ? AND p.deleted_at IS NULL AND p.status = 'active'
       AND (SELECT COUNT(DISTINCT m.id)
            FROM product_media pm JOIN media_assets m ON m.id = pm.media_id AND m.workspace_id = pm.workspace_id
            WHERE pm.workspace_id = p.workspace_id AND pm.product_id = p.id
              AND m.media_type = 'image' AND m.origin = 'source' AND m.status = 'ready') >= 2
       AND NOT EXISTS (
         SELECT 1 FROM automation_runs active
         WHERE active.workspace_id = p.workspace_id AND active.product_id = p.id
           AND active.status IN ('queued', 'processing')
       )
     ORDER BY COALESCE((
       SELECT MAX(done.created_at) FROM automation_runs done
       WHERE done.workspace_id = p.workspace_id AND done.product_id = p.id AND done.status = 'completed'
     ), 0) ASC, p.updated_at ASC, p.base_sku ASC
     LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID).first<{ id: string; base_sku: string }>();
  if (!product) return { queued: false, day, reason: "no_ready_product" };

  const queued = await queueAutomationRun({
    productId: product.id,
    imageCount: 6,
    targetProviders: targets,
    idempotencyKey: `daily:${day}:${product.id}`,
  }, "daily-automation");
  return { queued: true, day, productId: product.id, sku: product.base_sku, run: queued.run };
}
''', encoding="utf-8")

# Cron: create daily plan first, process up to 8 independent AI steps, then schedule/dispatch.
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
    const scheduler = await runSchedulerTick();
    const dispatcher = await runPublishDispatcher();
    return ok({ daily, automation, scheduler, dispatcher }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "CRON_TICK_FAILED";
    if (code === "DATABASE_UNAVAILABLE") return fail(code, "Cơ sở dữ liệu lịch chạy nền chưa sẵn sàng.", 503);
    return fail("CRON_TICK_FAILED", "Không thể xử lý công việc nền lúc này.", 500);
  }
}
''', encoding="utf-8")

# 7) Documentation: canonical folder convention and exact 2+6 media set.
readme = ROOT / "README.md"
text = readme.read_text(encoding="utf-8")
text = text.replace("Trong thư mục Drive nguồn, mỗi sản phẩm là một thư mục con có tên đúng bằng SKU.", "Trong thư mục Drive nguồn, mỗi sản phẩm dùng thư mục chuẩn `SKU <mã SKU>`, ví dụ Sheet `PH0006` ↔ Drive `SKU PH0006`. Hệ thống vẫn nhận thư mục cũ chỉ có `PH0006` để tương thích ngược.")
text = text.replace("Ảnh AI được đặt tên dạng `<SKU>-AI-01.png` đến `<SKU>-AI-06.png`.", "Mỗi sản phẩm phải có tối thiểu 2 ảnh gốc. AI dùng đồng thời 2 ảnh gốc làm tham chiếu và tạo 6 ảnh mới; bộ media chuẩn của một lượt automation là 2 ảnh gốc + 6 ảnh AI. Ảnh AI được đặt tên dạng `<SKU>-AI-01.png` đến `<SKU>-AI-06.png` và ghi trở lại đúng thư mục `SKU <SKU>`.")
readme.write_text(text, encoding="utf-8")

# 8) Regression contract tests for the fixes.
test = ROOT / "tests/taha-e2e-fixes.test.mjs"
test.write_text('''import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Drive SKU normalization accepts canonical SKU prefix", () => {
  const source = read("lib/integrations/google-drive.ts");
  assert.match(source, /replace\(\/\^SKU\\s\+\/i, ""\)/);
  assert.match(source, /`SKU \$\{skuKey\}`/);
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

print("TAHA end-to-end fixes applied")
