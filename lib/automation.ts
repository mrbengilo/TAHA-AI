import { generateProductContent, editProductImage } from "./ai/openai";
import { getRuntimeEnv } from "./integrations/env";
import { exportGeneratedImageToGoogleDrive } from "./integrations/google-sync";
import { ensureWorkspace, TAHA_WORKSPACE_ID } from "./integrations/store";
import { mediaBlob } from "./media";

export const AUTOMATION_TARGET_PROVIDERS = [
  "facebook",
  "zalo_personal",
  "website",
  "tiktok_shop",
  "shopee",
] as const;

type TargetProvider = (typeof AUTOMATION_TARGET_PROVIDERS)[number];
type StepType = "content" | "image" | "finalize";
const AUTOMATION_LEASE_MS = 15 * 60_000;

type AutomationStatement = {
  bind(...values: unknown[]): AutomationStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
};

export type AutomationDatabase = {
  prepare(query: string): AutomationStatement;
  batch(statements: AutomationStatement[]): Promise<Array<{ meta?: { changes?: number } }>>;
};

type RunRow = {
  id: string;
  workspace_id: string;
  product_id: string;
  source_media_id: string;
  request_key: string;
  status: string;
  requested_image_count: number;
  completed_image_count: number;
  target_providers_json: string;
  content_json: string | null;
  output_media_ids_json: string;
  text_model: string | null;
  image_model: string | null;
  prompt_version: string;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
};

type StepRow = {
  id: string;
  workspace_id: string;
  run_id: string;
  step_type: StepType;
  ordinal: number;
  status: string;
  available_at: number;
  attempt_count: number;
  max_attempts: number;
  result_json: string;
};

type ProductSnapshot = {
  id: string;
  base_sku: string;
  name: string;
  description: string;
  brand: string | null;
  category: string | null;
  currency: string;
  price_minor: number;
  compare_at_price_minor: number | null;
  inventory_quantity: number;
};

export type QueueAutomationInput = {
  productId?: unknown;
  sourceMediaId?: unknown;
  idempotencyKey?: unknown;
  imageCount?: unknown;
  targetProviders?: unknown;
};

export type AutomationWorkerResult = {
  checked: number;
  leased: number;
  completed: number;
  retrying: number;
  failed: number;
  skipped: number;
  errors: Array<{ stepId: string; code: string }>;
  processedAt: number;
};

export class AutomationError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
    public readonly status = 400,
  ) {
    super(code);
    this.name = "AutomationError";
  }
}

function database(override?: AutomationDatabase) {
  const value = override ?? (getRuntimeEnv().DB as unknown as AutomationDatabase | undefined);
  if (!value) throw new AutomationError("DATABASE_UNAVAILABLE", "Cơ sở dữ liệu chưa sẵn sàng.", 503);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function cleanText(value: unknown, max = 20_000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizeTargets(value: unknown): TargetProvider[] {
  const requested = Array.isArray(value) ? value : AUTOMATION_TARGET_PROVIDERS;
  const allowed = new Set<string>(AUTOMATION_TARGET_PROVIDERS);
  const unique = [...new Set(requested.filter((item): item is string => typeof item === "string" && allowed.has(item)))];
  if (!unique.length) throw new AutomationError("TARGET_PROVIDERS_REQUIRED", "Hãy chọn ít nhất một kênh tạo nội dung.");
  return unique as TargetProvider[];
}

function normalizeImageCount(value: unknown) {
  const count = value === undefined ? 6 : Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 6) {
    throw new AutomationError("IMAGE_COUNT_INVALID", "Số ảnh tạo thêm phải từ 1 đến 6.");
  }
  return count;
}

function requiredText(value: unknown, field: string, max: number) {
  const normalized = cleanText(value, max);
  if (!normalized) throw new AutomationError("INVALID_AUTOMATION_INPUT", `Thiếu ${field}.`);
  return normalized;
}

function changes(result: { meta?: { changes?: number } } | undefined) {
  return Number(result?.meta?.changes ?? 0);
}

async function digestHex(value: string | ArrayBuffer) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((item) => item.toString(16).padStart(2, "0")).join("");
}

async function stableId(namespace: string, value: string) {
  return `${namespace}_${(await digestHex(value)).slice(0, 40)}`;
}

async function productSnapshot(db: AutomationDatabase, productId: string) {
  const product = await db.prepare(
    `SELECT p.id, p.base_sku, p.name, p.description, p.brand, p.category, p.currency,
            COALESCE(MIN(v.price_minor), 0) AS price_minor,
            MAX(v.compare_at_price_minor) AS compare_at_price_minor,
            COALESCE(SUM(v.inventory_quantity), 0) AS inventory_quantity
     FROM products p
     LEFT JOIN product_variants v ON v.product_id = p.id AND v.workspace_id = p.workspace_id AND v.status = 'active'
     WHERE p.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL
     GROUP BY p.id LIMIT 1`,
  ).bind(productId, TAHA_WORKSPACE_ID).first<ProductSnapshot>();
  if (!product) throw new AutomationError("PRODUCT_NOT_FOUND", "Không tìm thấy sản phẩm.", 404);
  return product;
}

async function sourceMediaId(db: AutomationDatabase, productId: string, requested: string | null) {
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
}

function publicRun(row: RunRow) {
  return {
    id: row.id,
    productId: row.product_id,
    sourceMediaId: row.source_media_id,
    status: row.status,
    requestedImageCount: row.requested_image_count,
    completedImageCount: row.completed_image_count,
    targetProviders: json<string[]>(row.target_providers_json, []),
    content: json<Record<string, unknown> | null>(row.content_json, null),
    outputMediaIds: json<string[]>(row.output_media_ids_json, []),
    textModel: row.text_model,
    imageModel: row.image_model,
    promptVersion: row.prompt_version,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function isSameAutomationRequest(
  existing: RunRow,
  input: { productId: string; mediaId: string; imageCount: number; targetProviders: TargetProvider[] },
) {
  return existing.product_id === input.productId
    && existing.source_media_id === input.mediaId
    && existing.requested_image_count === input.imageCount
    && JSON.stringify(json<string[]>(existing.target_providers_json, []).sort())
      === JSON.stringify([...input.targetProviders].sort());
}

async function activeAutomationRun(db: AutomationDatabase, productId: string) {
  return db.prepare(
    `SELECT * FROM automation_runs
     WHERE workspace_id = ? AND product_id = ? AND status IN ('queued', 'processing')
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID, productId).first<RunRow>();
}

function automationAlreadyRunning() {
  return new AutomationError(
    "AUTOMATION_ALREADY_RUNNING",
    "SKU này đang được AI xử lý. Hãy chờ công việc hiện tại hoàn tất.",
    409,
  );
}

export async function queueAutomationRun(input: QueueAutomationInput, actorId?: string | null) {
  await ensureWorkspace();
  const db = database();
  const productId = requiredText(input.productId, "productId", 120);
  const requestKey = requiredText(input.idempotencyKey, "idempotencyKey", 200);
  if (requestKey.length < 8) throw new AutomationError("IDEMPOTENCY_KEY_INVALID", "Khóa chống trùng quá ngắn.");
  const imageCount = normalizeImageCount(input.imageCount);
  const targetProviders = normalizeTargets(input.targetProviders);
  await productSnapshot(db, productId);
  const mediaId = await sourceMediaId(db, productId, cleanText(input.sourceMediaId, 120) || null);

  const existing = await db.prepare(
    `SELECT * FROM automation_runs WHERE workspace_id = ? AND request_key = ? LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID, requestKey).first<RunRow>();
  if (existing) {
    if (!isSameAutomationRequest(existing, { productId, mediaId, imageCount, targetProviders })) {
      throw new AutomationError("IDEMPOTENCY_KEY_REUSED", "Khóa chống trùng đã được dùng cho yêu cầu khác.", 409);
    }
    return { run: publicRun(existing), replayed: true };
  }

  if (await activeAutomationRun(db, productId)) throw automationAlreadyRunning();

  const now = Date.now();
  const runId = crypto.randomUUID();
  const statements: AutomationStatement[] = [
    db.prepare(
      `INSERT INTO automation_runs
       (id, workspace_id, product_id, source_media_id, request_key, status, requested_image_count,
        completed_image_count, target_providers_json, output_media_ids_json, prompt_version,
        created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, '[]', 'taha-product-v1', ?, ?, ?)`,
    ).bind(runId, TAHA_WORKSPACE_ID, productId, mediaId, requestKey, imageCount, JSON.stringify(targetProviders), actorId?.slice(0, 160) ?? "operator", now, now),
    db.prepare(
      `INSERT INTO automation_steps
       (id, workspace_id, run_id, step_type, ordinal, status, available_at, attempt_count, max_attempts,
        result_json, created_at, updated_at)
       VALUES (?, ?, ?, 'content', 0, 'queued', ?, 0, 3, '{}', ?, ?)`,
    ).bind(await stableId("step", `${runId}:content:0`), TAHA_WORKSPACE_ID, runId, now, now, now),
  ];
  for (let ordinal = 1; ordinal <= imageCount; ordinal += 1) {
    statements.push(db.prepare(
      `INSERT INTO automation_steps
       (id, workspace_id, run_id, step_type, ordinal, status, available_at, attempt_count, max_attempts,
        result_json, created_at, updated_at)
       VALUES (?, ?, ?, 'image', ?, 'queued', ?, 0, 3, '{}', ?, ?)`,
    ).bind(await stableId("step", `${runId}:image:${ordinal}`), TAHA_WORKSPACE_ID, runId, ordinal, now, now, now));
  }
  statements.push(db.prepare(
    `INSERT INTO automation_steps
     (id, workspace_id, run_id, step_type, ordinal, status, available_at, attempt_count, max_attempts,
      result_json, created_at, updated_at)
     VALUES (?, ?, ?, 'finalize', 0, 'queued', ?, 0, 3, '{}', ?, ?)`,
  ).bind(await stableId("step", `${runId}:finalize:0`), TAHA_WORKSPACE_ID, runId, now, now, now));
  try {
    await db.batch(statements);
  } catch (error) {
    // The partial unique index is the authority for concurrent requests. D1
    // batches are atomic, so after a collision we can safely resolve either
    // an idempotent replay or a different active run without parsing driver
    // error strings.
    const racedExisting = await db.prepare(
      `SELECT * FROM automation_runs WHERE workspace_id = ? AND request_key = ? LIMIT 1`,
    ).bind(TAHA_WORKSPACE_ID, requestKey).first<RunRow>();
    if (racedExisting) {
      if (!isSameAutomationRequest(racedExisting, { productId, mediaId, imageCount, targetProviders })) {
        throw new AutomationError("IDEMPOTENCY_KEY_REUSED", "Khóa chống trùng đã được dùng cho yêu cầu khác.", 409);
      }
      return { run: publicRun(racedExisting), replayed: true };
    }
    if (await activeAutomationRun(db, productId)) throw automationAlreadyRunning();
    throw error;
  }
  const created = await db.prepare("SELECT * FROM automation_runs WHERE id = ? AND workspace_id = ?").bind(runId, TAHA_WORKSPACE_ID).first<RunRow>();
  if (!created) throw new AutomationError("AUTOMATION_QUEUE_FAILED", "Không thể tạo công việc AI.", 500);
  return { run: publicRun(created), replayed: false };
}

export async function listAutomationRuns(limit = 20) {
  const db = database();
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const rows = await db.prepare(
    `SELECT * FROM automation_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).bind(TAHA_WORKSPACE_ID, safeLimit).all<RunRow>();
  return (rows.results ?? []).map(publicRun);
}

export async function getAutomationRun(id: string) {
  const db = database();
  const row = await db.prepare("SELECT * FROM automation_runs WHERE id = ? AND workspace_id = ? LIMIT 1")
    .bind(id, TAHA_WORKSPACE_ID).first<RunRow>();
  if (!row) throw new AutomationError("AUTOMATION_RUN_NOT_FOUND", "Không tìm thấy công việc AI.", 404);
  const steps = await db.prepare(
    `SELECT id, step_type, ordinal, status, attempt_count, max_attempts, result_json, error_code,
            error_message, created_at, updated_at, started_at, completed_at
     FROM automation_steps WHERE run_id = ? AND workspace_id = ?
     ORDER BY CASE step_type WHEN 'content' THEN 0 WHEN 'image' THEN 1 ELSE 2 END, ordinal`,
  ).bind(id, TAHA_WORKSPACE_ID).all<Record<string, unknown>>();
  const drafts = await db.prepare(
    `SELECT id, target_provider, content_type, title, body, hashtags_json, status, created_at
     FROM content_drafts WHERE workspace_id = ? AND json_extract(generation_meta_json, '$.automationRunId') = ?
     ORDER BY created_at, target_provider`,
  ).bind(TAHA_WORKSPACE_ID, id).all<Record<string, unknown>>();
  return { ...publicRun(row), steps: steps.results ?? [], drafts: drafts.results ?? [] };
}

export async function cancelAutomationRun(id: string) {
  const db = database();
  const now = Date.now();
  const results = await db.batch([
    db.prepare(
      `UPDATE automation_runs SET status = 'cancelled', error_code = NULL, error_message = NULL,
       completed_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status IN ('queued', 'processing')`,
    ).bind(now, now, id, TAHA_WORKSPACE_ID),
    db.prepare(
      `UPDATE automation_steps SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
       completed_at = ?, updated_at = ? WHERE run_id = ? AND workspace_id = ?
       AND status IN ('queued', 'processing', 'retry_wait')`,
    ).bind(now, now, id, TAHA_WORKSPACE_ID),
  ]);
  if (changes(results[0]) === 0) {
    const existing = await db.prepare("SELECT status FROM automation_runs WHERE id = ? AND workspace_id = ?")
      .bind(id, TAHA_WORKSPACE_ID).first<{ status: string }>();
    if (!existing) throw new AutomationError("AUTOMATION_RUN_NOT_FOUND", "Không tìm thấy công việc AI.", 404);
    throw new AutomationError("AUTOMATION_RUN_NOT_CANCELLABLE", "Công việc AI đã kết thúc.", 409);
  }
  return { id, status: "cancelled" as const };
}

export async function retryAutomationRun(id: string) {
  const db = database();
  const now = Date.now();
  const existing = await db.prepare(
    "SELECT status FROM automation_runs WHERE id = ? AND workspace_id = ? LIMIT 1",
  ).bind(id, TAHA_WORKSPACE_ID).first<{ status: string }>();
  if (!existing) throw new AutomationError("AUTOMATION_RUN_NOT_FOUND", "Không tìm thấy công việc AI.", 404);
  if (existing.status !== "failed" && existing.status !== "cancelled") {
    throw new AutomationError("AUTOMATION_RUN_NOT_RETRYABLE", "Chỉ có thể thử lại công việc đã lỗi hoặc đã hủy.", 409);
  }
  await db.batch([
    db.prepare(
      `UPDATE automation_runs SET status = 'processing', error_code = NULL, error_message = NULL,
       completed_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    ).bind(now, id, TAHA_WORKSPACE_ID),
    db.prepare(
      `UPDATE automation_steps SET status = 'queued', available_at = ?, attempt_count = 0,
       lease_owner = NULL, lease_expires_at = NULL, error_code = NULL, error_message = NULL,
       started_at = NULL, completed_at = NULL, updated_at = ?
       WHERE run_id = ? AND workspace_id = ? AND status IN ('failed', 'cancelled')`,
    ).bind(now, now, id, TAHA_WORKSPACE_ID),
  ]);
  return { id, status: "processing" as const };
}

async function loadRun(db: AutomationDatabase, runId: string) {
  const row = await db.prepare("SELECT * FROM automation_runs WHERE id = ? AND workspace_id = ? LIMIT 1")
    .bind(runId, TAHA_WORKSPACE_ID).first<RunRow>();
  if (!row) throw new Error("AUTOMATION_RUN_NOT_FOUND");
  return row;
}

async function claimStep(db: AutomationDatabase, step: StepRow, workerId: string, now: number) {
  return db.prepare(
    `UPDATE automation_steps SET status = 'processing', attempt_count = attempt_count + 1,
     lease_owner = ?, lease_expires_at = ?, started_at = COALESCE(started_at, ?),
     error_code = NULL, error_message = NULL, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status IN ('queued', 'retry_wait') AND available_at <= ?
       AND EXISTS (
         SELECT 1 FROM automation_runs r
         WHERE r.id = automation_steps.run_id AND r.workspace_id = automation_steps.workspace_id
           AND r.status IN ('queued', 'processing')
       )
     RETURNING attempt_count, max_attempts`,
  ).bind(workerId, now + AUTOMATION_LEASE_MS, now, now, step.id, TAHA_WORKSPACE_ID, now)
    .first<{ attempt_count: number; max_attempts: number }>();
}

function safeErrorCode(error: unknown) {
  const candidate = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : error instanceof Error ? error.message : "AUTOMATION_STEP_FAILED";
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(candidate) ? candidate : "AUTOMATION_STEP_FAILED";
}

async function processContent(db: AutomationDatabase, run: RunRow, step: StepRow, workerId: string, now: number) {
  const product = await productSnapshot(db, run.product_id);
  const generated = await generateProductContent({
    product: {
      sku: product.base_sku,
      name: product.name,
      description: product.description,
      brand: product.brand,
      category: product.category,
      currency: product.currency,
      priceMinor: product.price_minor,
      compareAtPriceMinor: product.compare_at_price_minor,
      inventoryQuantity: product.inventory_quantity,
    },
    targetProviders: json<string[]>(run.target_providers_json, []),
  });
  const completedAt = Date.now();
  const saved = await db.batch([
    db.prepare(
      `UPDATE automation_runs SET content_json = ?, text_model = ?, status = 'processing',
       started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status IN ('queued', 'processing')
         AND EXISTS (
           SELECT 1 FROM automation_steps s
           WHERE s.id = ? AND s.run_id = automation_runs.id AND s.workspace_id = automation_runs.workspace_id
             AND s.status = 'processing' AND s.lease_owner = ? AND s.lease_expires_at > ?
         )`,
    ).bind(
      JSON.stringify(generated.content),
      generated.model,
      now,
      completedAt,
      run.id,
      TAHA_WORKSPACE_ID,
      step.id,
      workerId,
      completedAt,
    ),
    db.prepare(
      `UPDATE automation_steps SET status = 'completed', result_json = ?, lease_owner = NULL,
       lease_expires_at = NULL, completed_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'processing' AND lease_owner = ?
         AND lease_expires_at > ?
         AND EXISTS (
           SELECT 1 FROM automation_runs r
           WHERE r.id = automation_steps.run_id AND r.workspace_id = automation_steps.workspace_id
             AND r.status IN ('queued', 'processing')
         )`,
    ).bind(
      JSON.stringify({ model: generated.model, usage: generated.usage ?? {} }),
      completedAt,
      completedAt,
      step.id,
      TAHA_WORKSPACE_ID,
      workerId,
      completedAt,
    ),
  ]);
  if (changes(saved[0]) === 0 || changes(saved[1]) === 0) throw new Error("AUTOMATION_LEASE_LOST");
}

function imageExtension(mimeType: string) {
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/jpeg") return "jpg";
  return "png";
}

async function finishImageStep(
  db: AutomationDatabase,
  run: RunRow,
  step: StepRow,
  workerId: string,
  result: { mediaId: string; storageKey: string; model: string; driveExport: Record<string, unknown>; reused?: boolean },
) {
  const completedAt = Date.now();
  const saved = await db.batch([
    db.prepare(
      `UPDATE automation_steps SET status = 'completed', result_json = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'processing' AND lease_owner = ?
         AND lease_expires_at > ?
         AND EXISTS (
           SELECT 1 FROM automation_runs r
           WHERE r.id = automation_steps.run_id AND r.workspace_id = automation_steps.workspace_id
             AND r.status IN ('queued', 'processing')
         )`,
    ).bind(JSON.stringify(result), completedAt, completedAt, step.id, TAHA_WORKSPACE_ID, workerId, completedAt),
    db.prepare(
      `UPDATE automation_runs SET
         completed_image_count = (
           SELECT COUNT(*) FROM automation_steps s
           WHERE s.run_id = automation_runs.id AND s.workspace_id = automation_runs.workspace_id
             AND s.step_type = 'image' AND s.status = 'completed'
             AND json_type(s.result_json, '$.mediaId') = 'text'
         ),
         output_media_ids_json = COALESCE((
           SELECT json_group_array(media_id) FROM (
             SELECT json_extract(s.result_json, '$.mediaId') AS media_id
             FROM automation_steps s
             WHERE s.run_id = automation_runs.id AND s.workspace_id = automation_runs.workspace_id
               AND s.step_type = 'image' AND s.status = 'completed'
               AND json_type(s.result_json, '$.mediaId') = 'text'
             ORDER BY s.ordinal
           )
         ), '[]'),
         image_model = ?, status = 'processing', started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status IN ('queued', 'processing')
         AND EXISTS (
           SELECT 1 FROM automation_steps s
           WHERE s.id = ? AND s.run_id = automation_runs.id AND s.workspace_id = automation_runs.workspace_id
             AND s.step_type = 'image' AND s.status = 'completed'
             AND s.lease_owner = ? AND s.lease_expires_at > ?
         )`,
    ).bind(result.model, completedAt, completedAt, run.id, TAHA_WORKSPACE_ID, step.id, workerId, completedAt),
    db.prepare(
      `UPDATE automation_steps SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'completed' AND lease_owner = ?
         AND lease_expires_at > ?
         AND EXISTS (
           SELECT 1 FROM automation_runs r
           WHERE r.id = automation_steps.run_id AND r.workspace_id = automation_steps.workspace_id
             AND r.status IN ('queued', 'processing')
         )`,
    ).bind(completedAt, step.id, TAHA_WORKSPACE_ID, workerId, completedAt),
  ]);
  if (saved.some((entry) => changes(entry) === 0)) throw new Error("AUTOMATION_LEASE_LOST");
}

async function processImage(db: AutomationDatabase, run: RunRow, step: StepRow, workerId: string) {
  const product = await productSnapshot(db, run.product_id);
  const mediaId = await stableId("media", `${run.id}:image:${step.ordinal}`);
  const existing = await db.prepare(
    `SELECT storage_key, mime_type, metadata_json FROM media_assets
     WHERE id = ? AND workspace_id = ? AND origin IN ('generated', 'derived') AND status = 'ready' LIMIT 1`,
  ).bind(mediaId, TAHA_WORKSPACE_ID).first<{ storage_key: string; mime_type: string | null; metadata_json: string }>();
  if (existing?.storage_key) {
    const metadata = record(json(existing.metadata_json, {}));
    const extension = imageExtension(existing.mime_type || "image/png");
    const filename = cleanText(metadata.name, 180)
      || `${product.base_sku}-AI-${String(step.ordinal).padStart(2, "0")}.${extension}`;
    const driveExport = await exportGeneratedImageToGoogleDrive(
      { productId: run.product_id, mediaId, filename },
      `automation:${run.id}`,
    );
    await finishImageStep(db, run, step, workerId, {
      mediaId,
      storageKey: existing.storage_key,
      model: run.image_model || getRuntimeEnv().OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2",
      driveExport,
      reused: true,
    });
    return;
  }
  const source = await mediaBlob(run.source_media_id, 20 * 1024 * 1024);
  const edited = await editProductImage({
    source: source.blob,
    filename: source.filename,
    mimeType: source.mimeType,
    product: { sku: product.base_sku, name: product.name },
    layoutIndex: step.ordinal,
  });
  const extension = imageExtension(edited.mimeType);
  const storageKey = `automation/${TAHA_WORKSPACE_ID}/${run.id}/${String(step.ordinal).padStart(2, "0")}.${extension}`;
  const filename = `${product.base_sku}-AI-${String(step.ordinal).padStart(2, "0")}.${extension}`;
  const buffer = await edited.image.arrayBuffer();
  const sha256 = await digestHex(buffer);
  const bucket = getRuntimeEnv().MEDIA;
  if (!bucket) throw new Error("MEDIA_BUCKET_UNAVAILABLE");
  await bucket.put(storageKey, buffer, {
    httpMetadata: { contentType: edited.mimeType },
    customMetadata: { workspaceId: TAHA_WORKSPACE_ID, runId: run.id, productId: run.product_id },
  });
  const persistedAt = Date.now();
  try {
    const statements: AutomationStatement[] = [
      db.prepare(
        `INSERT INTO media_assets
         (id, workspace_id, channel_id, media_type, origin, storage_provider, storage_key, mime_type,
          byte_size, sha256, alt_text, generation_prompt, status, metadata_json, created_at, updated_at)
         SELECT ?, ?, 'google_drive', 'image', 'generated', 'r2', ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM automation_runs r JOIN automation_steps s
             ON s.run_id = r.id AND s.workspace_id = r.workspace_id
           WHERE r.id = ? AND r.workspace_id = ? AND r.status IN ('queued', 'processing')
             AND s.id = ? AND s.status = 'processing' AND s.lease_owner = ?
             AND s.lease_expires_at > ?
         )
         ON CONFLICT(id) DO UPDATE SET storage_key = excluded.storage_key, mime_type = excluded.mime_type,
          byte_size = excluded.byte_size, sha256 = excluded.sha256, status = 'ready', updated_at = excluded.updated_at`,
      ).bind(
        mediaId,
        TAHA_WORKSPACE_ID,
        storageKey,
        edited.mimeType,
        buffer.byteLength,
        sha256,
        `${product.name} - bố cục ${step.ordinal}`,
        edited.revisedPrompt ?? null,
        JSON.stringify({ name: filename, automationRunId: run.id, layoutIndex: step.ordinal, sourceMediaId: run.source_media_id }),
        persistedAt,
        persistedAt,
        run.id,
        TAHA_WORKSPACE_ID,
        step.id,
        workerId,
        persistedAt,
      ),
      db.prepare(
        `INSERT OR IGNORE INTO product_media
         (id, workspace_id, product_id, media_id, role, sort_order, created_at)
         SELECT ?, ?, ?, ?, 'generated', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM automation_runs r JOIN automation_steps s
             ON s.run_id = r.id AND s.workspace_id = r.workspace_id
           WHERE r.id = ? AND r.workspace_id = ? AND r.status IN ('queued', 'processing')
             AND s.id = ? AND s.status = 'processing' AND s.lease_owner = ?
             AND s.lease_expires_at > ?
         )`,
      ).bind(
        await stableId("pm", `${run.id}:${mediaId}`),
        TAHA_WORKSPACE_ID,
        run.product_id,
        mediaId,
        100 + step.ordinal,
        persistedAt,
        run.id,
        TAHA_WORKSPACE_ID,
        step.id,
        workerId,
        persistedAt,
      ),
    ];
    for (const provider of json<TargetProvider[]>(run.target_providers_json, [])) {
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO channel_media_links
         (id, workspace_id, channel_id, media_id, created_by, created_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM automation_runs r JOIN automation_steps s
             ON s.run_id = r.id AND s.workspace_id = r.workspace_id
           WHERE r.id = ? AND r.workspace_id = ? AND r.status IN ('queued', 'processing')
             AND s.id = ? AND s.status = 'processing' AND s.lease_owner = ?
             AND s.lease_expires_at > ?
         )`,
      ).bind(
        await stableId("cml", `${provider}:${mediaId}`),
        TAHA_WORKSPACE_ID,
        provider,
        mediaId,
        `automation:${run.id}`,
        persistedAt,
        run.id,
        TAHA_WORKSPACE_ID,
        step.id,
        workerId,
        persistedAt,
      ));
    }
    const persisted = await db.batch(statements);
    if (changes(persisted[0]) === 0) throw new Error("AUTOMATION_LEASE_LOST");
  } catch (error) {
    await bucket.delete(storageKey).catch(() => undefined);
    throw error;
  }

  const driveExport = await exportGeneratedImageToGoogleDrive(
    { productId: run.product_id, mediaId, filename },
    `automation:${run.id}`,
  );
  await finishImageStep(db, run, step, workerId, {
    mediaId,
    storageKey,
    model: edited.model,
    driveExport,
  });
}

function channelContent(content: Record<string, unknown>, provider: TargetProvider) {
  const channels = record(content.channels);
  const item = record(channels[provider] ?? content[provider]);
  const title = cleanText(item.title ?? item.productTitle ?? content.productTitle, 255);
  const body = cleanText(item.body ?? item.message ?? item.description ?? content.productDescription, 20_000);
  const hashtags = Array.isArray(item.hashtags)
    ? [...new Set(item.hashtags.map((value) => cleanText(value, 80).replace(/^#+/, "")).filter(Boolean))].slice(0, 20)
    : [];
  return { title, body, hashtags, platformData: record(item.platformData) };
}

function contentType(provider: TargetProvider) {
  if (provider === "tiktok_shop" || provider === "shopee") return "product_listing";
  if (provider === "website") return "website_article";
  return "social_post";
}

function nextLocalSlot(now: number, hour: number) {
  const offset = 7 * 60 * 60 * 1_000;
  const local = new Date(now + offset);
  let candidate = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, 0) - offset;
  if (candidate <= now + 30 * 60 * 1_000) candidate += 24 * 60 * 60 * 1_000;
  return candidate;
}

async function processFinalize(db: AutomationDatabase, run: RunRow, step: StepRow, workerId: string, now: number) {
  const current = await loadRun(db, run.id);
  if (current.status !== "queued" && current.status !== "processing") throw new Error("AUTOMATION_LEASE_LOST");
  const incomplete = await db.prepare(
    `SELECT COUNT(*) AS total FROM automation_steps WHERE run_id = ? AND workspace_id = ?
     AND step_type IN ('content', 'image') AND status != 'completed'`,
  ).bind(run.id, TAHA_WORKSPACE_ID).first<{ total: number }>();
  if (Number(incomplete?.total ?? 0) > 0) throw new Error("AUTOMATION_PREREQUISITES_PENDING");
  const content = json<Record<string, unknown>>(current.content_json, {});
  const completedImages = await db.prepare(
    `SELECT ordinal, result_json FROM automation_steps
     WHERE run_id = ? AND workspace_id = ? AND step_type = 'image' AND status = 'completed'
     ORDER BY ordinal`,
  ).bind(run.id, TAHA_WORKSPACE_ID).all<{ ordinal: number; result_json: string }>();
  const mediaIds = (completedImages.results ?? [])
    .map((row) => cleanText(record(json(row.result_json, {})).mediaId, 120))
    .filter(Boolean);
  if (!Object.keys(content).length || mediaIds.length !== current.requested_image_count) {
    throw new Error("AUTOMATION_PREREQUISITES_PENDING");
  }
  const finalizedAt = Date.now();
  const statements: AutomationStatement[] = [];
  const draftIds: string[] = [];
  const scheduleIds: string[] = [];
  const scheduleHours: Partial<Record<TargetProvider, number>> = { facebook: 8, zalo_personal: 9, website: 12 };
  for (const provider of json<TargetProvider[]>(current.target_providers_json, [])) {
    const draftId = await stableId("draft", `${run.id}:${provider}`);
    draftIds.push(draftId);
    const generated = channelContent(content, provider);
    const platformData = {
      ...generated.platformData,
      automationRunId: run.id,
      sku: (await productSnapshot(db, run.product_id)).base_sku,
      generatedImageCount: mediaIds.length,
    };
    statements.push(db.prepare(
      `INSERT INTO content_drafts
       (id, workspace_id, product_id, target_provider, content_type, language, title, body,
        hashtags_json, platform_data_json, status, version, generator, model, prompt_version,
        generation_meta_json, approved_by, approved_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'vi', ?, ?, ?, ?, 'approved', 1, 'openai', ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM automation_runs r JOIN automation_steps s
           ON s.run_id = r.id AND s.workspace_id = r.workspace_id
         WHERE r.id = ? AND r.workspace_id = ? AND r.status IN ('queued', 'processing')
           AND s.id = ? AND s.status = 'processing' AND s.lease_owner = ?
           AND s.lease_expires_at > ?
       )
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      draftId,
      TAHA_WORKSPACE_ID,
      run.product_id,
      provider,
      contentType(provider),
      generated.title || null,
      generated.body,
      JSON.stringify(generated.hashtags),
      JSON.stringify(platformData),
      current.text_model,
      current.prompt_version,
      JSON.stringify({ automationRunId: run.id, sourceMediaId: run.source_media_id, outputMediaIds: mediaIds }),
      `automation:${run.id}`,
      finalizedAt,
      finalizedAt,
      finalizedAt,
      run.id,
      TAHA_WORKSPACE_ID,
      step.id,
      workerId,
      finalizedAt,
    ));
    for (let index = 0; index < mediaIds.length; index += 1) {
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO content_draft_media
         (id, workspace_id, draft_id, media_id, role, sort_order, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM automation_runs r JOIN automation_steps s
             ON s.run_id = r.id AND s.workspace_id = r.workspace_id
           WHERE r.id = ? AND r.workspace_id = ? AND r.status IN ('queued', 'processing')
             AND s.id = ? AND s.status = 'processing' AND s.lease_owner = ?
             AND s.lease_expires_at > ?
         )`,
      ).bind(
        await stableId("cdm", `${draftId}:${mediaIds[index]}`),
        TAHA_WORKSPACE_ID,
        draftId,
        mediaIds[index],
        index === 0 ? "primary" : "attachment",
        index,
        finalizedAt,
        run.id,
        TAHA_WORKSPACE_ID,
        step.id,
        workerId,
        finalizedAt,
      ));
    }
    const scheduleHour = scheduleHours[provider];
    if (scheduleHour !== undefined) {
      const connection = await db.prepare(
        `SELECT id, publish_mode FROM channel_connections
         WHERE workspace_id = ? AND provider = ? AND status = 'connected'
         ORDER BY updated_at DESC LIMIT 1`,
      ).bind(TAHA_WORKSPACE_ID, provider).first<{ id: string; publish_mode: string }>();
      if (connection) {
        const scheduleId = await stableId("schedule", `${run.id}:${provider}`);
        scheduleIds.push(scheduleId);
        const runAt = nextLocalSlot(now, scheduleHour);
        statements.push(db.prepare(
          `UPDATE schedules SET status = 'paused', next_run_at = NULL, updated_at = ?
           WHERE workspace_id = ? AND connection_id = ? AND status = 'active'
             AND schedule_kind = 'once' AND created_by GLOB 'automation:*'
             AND EXISTS (
               SELECT 1 FROM automation_runs r JOIN automation_steps s
                 ON s.run_id = r.id AND s.workspace_id = r.workspace_id
               WHERE r.id = ? AND r.workspace_id = ? AND r.status IN ('queued', 'processing')
                 AND s.id = ? AND s.status = 'processing' AND s.lease_owner = ?
                 AND s.lease_expires_at > ?
             )
             AND draft_id IN (
               SELECT id FROM content_drafts
               WHERE workspace_id = ? AND product_id = ? AND target_provider = ?
             )`,
        ).bind(
          finalizedAt,
          TAHA_WORKSPACE_ID,
          connection.id,
          run.id,
          TAHA_WORKSPACE_ID,
          step.id,
          workerId,
          finalizedAt,
          TAHA_WORKSPACE_ID,
          run.product_id,
          provider,
        ));
        statements.push(db.prepare(
          `INSERT INTO schedules
           (id, workspace_id, draft_id, connection_id, status, schedule_kind, run_at, weekdays_json,
            timezone, next_run_at, execution_mode, publish_options_json, created_by, created_at, updated_at)
           SELECT ?, ?, ?, ?, 'active', 'once', ?, '[]', 'Asia/Ho_Chi_Minh', ?, ?, '{}', ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM automation_runs r JOIN automation_steps s
               ON s.run_id = r.id AND s.workspace_id = r.workspace_id
             WHERE r.id = ? AND r.workspace_id = ? AND r.status IN ('queued', 'processing')
               AND s.id = ? AND s.status = 'processing' AND s.lease_owner = ?
               AND s.lease_expires_at > ?
           )
           ON CONFLICT(id) DO NOTHING`,
        ).bind(
          scheduleId,
          TAHA_WORKSPACE_ID,
          draftId,
          connection.id,
          runAt,
          runAt,
          provider === "zalo_personal" || connection.publish_mode === "assisted" ? "assisted" : "auto",
          `automation:${run.id}`,
          finalizedAt,
          finalizedAt,
          run.id,
          TAHA_WORKSPACE_ID,
          step.id,
          workerId,
          finalizedAt,
        ));
      }
    }
  }
  statements.push(
    db.prepare(
      `UPDATE automation_runs SET status = 'completed', completed_image_count = ?, output_media_ids_json = ?,
       completed_at = ?, updated_at = ?, error_code = NULL, error_message = NULL
       WHERE id = ? AND workspace_id = ? AND status IN ('queued', 'processing')
         AND EXISTS (
           SELECT 1 FROM automation_steps s
           WHERE s.id = ? AND s.run_id = automation_runs.id AND s.workspace_id = automation_runs.workspace_id
             AND s.status = 'processing' AND s.lease_owner = ? AND s.lease_expires_at > ?
         )`,
    ).bind(
      mediaIds.length,
      JSON.stringify(mediaIds),
      finalizedAt,
      finalizedAt,
      run.id,
      TAHA_WORKSPACE_ID,
      step.id,
      workerId,
      finalizedAt,
    ),
    db.prepare(
      `UPDATE automation_steps SET status = 'completed', result_json = ?, lease_owner = NULL,
       lease_expires_at = NULL, completed_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'processing' AND lease_owner = ?
         AND lease_expires_at > ?
         AND EXISTS (
           SELECT 1 FROM automation_runs r
           WHERE r.id = automation_steps.run_id AND r.workspace_id = automation_steps.workspace_id
             AND r.status = 'completed'
         )`,
    ).bind(
      JSON.stringify({ draftIds, scheduleIds }),
      finalizedAt,
      finalizedAt,
      step.id,
      TAHA_WORKSPACE_ID,
      workerId,
      finalizedAt,
    ),
  );
  const committed = await db.batch(statements);
  if (changes(committed[committed.length - 2]) === 0 || changes(committed[committed.length - 1]) === 0) {
    throw new Error("AUTOMATION_LEASE_LOST");
  }
}

async function retryOrFail(
  db: AutomationDatabase,
  step: StepRow,
  lease: { attempt_count: number; max_attempts: number },
  workerId: string,
  error: unknown,
  now: number,
) {
  const code = safeErrorCode(error);
  if (code === "AUTOMATION_PREREQUISITES_PENDING") {
    const requeued = await db.prepare(
      `UPDATE automation_steps SET status = 'queued', available_at = ?, attempt_count = MAX(0, attempt_count - 1),
       lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'processing' AND lease_owner = ?
         AND lease_expires_at > ?
         AND EXISTS (
           SELECT 1 FROM automation_runs r
           WHERE r.id = automation_steps.run_id AND r.workspace_id = automation_steps.workspace_id
             AND r.status IN ('queued', 'processing')
         )`,
    ).bind(now + 5_000, now, step.id, TAHA_WORKSPACE_ID, workerId, now).run();
    if (changes(requeued) === 0) return { state: "skipped" as const, code: "AUTOMATION_LEASE_LOST" };
    return { state: "skipped" as const, code };
  }
  if (lease.attempt_count < lease.max_attempts) {
    const availableAt = now + Math.min(15 * 60_000, 30_000 * (2 ** Math.max(0, lease.attempt_count - 1)));
    const retrying = await db.prepare(
      `UPDATE automation_steps SET status = 'retry_wait', available_at = ?, error_code = ?,
       error_message = 'Lỗi tạm thời; hệ thống sẽ tự thử lại.', lease_owner = NULL,
       lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'processing' AND lease_owner = ?
         AND lease_expires_at > ?
         AND EXISTS (
           SELECT 1 FROM automation_runs r
           WHERE r.id = automation_steps.run_id AND r.workspace_id = automation_steps.workspace_id
             AND r.status IN ('queued', 'processing')
         )`,
    ).bind(availableAt, code, now, step.id, TAHA_WORKSPACE_ID, workerId, now).run();
    if (changes(retrying) === 0) return { state: "skipped" as const, code: "AUTOMATION_LEASE_LOST" };
    return { state: "retrying" as const, code };
  }
  const failed = await db.batch([
    db.prepare(
      `UPDATE automation_steps SET status = 'failed', error_code = ?,
       error_message = 'Không thể hoàn thành bước AI sau số lần thử cho phép.',
       completed_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'processing' AND lease_owner = ?
         AND lease_expires_at > ?
         AND EXISTS (
           SELECT 1 FROM automation_runs r
           WHERE r.id = automation_steps.run_id AND r.workspace_id = automation_steps.workspace_id
             AND r.status IN ('queued', 'processing')
         )`,
    ).bind(code, now, now, step.id, TAHA_WORKSPACE_ID, workerId, now),
    db.prepare(
      `UPDATE automation_runs SET status = 'failed', error_code = ?,
       error_message = 'Quy trình AI chưa hoàn tất; có thể thử lại sau khi kiểm tra cấu hình.',
       completed_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status IN ('queued', 'processing')
         AND EXISTS (
           SELECT 1 FROM automation_steps s
           WHERE s.id = ? AND s.run_id = automation_runs.id AND s.workspace_id = automation_runs.workspace_id
             AND s.status = 'failed' AND s.lease_owner = ? AND s.lease_expires_at > ?
         )`,
    ).bind(code, now, now, step.run_id, TAHA_WORKSPACE_ID, step.id, workerId, now),
    db.prepare(
      `UPDATE automation_steps SET status = 'cancelled', completed_at = ?, updated_at = ?
       WHERE run_id = ? AND workspace_id = ? AND status IN ('queued', 'retry_wait')
         AND EXISTS (
           SELECT 1 FROM automation_runs r
           WHERE r.id = automation_steps.run_id AND r.workspace_id = automation_steps.workspace_id
             AND r.status = 'failed'
         )`,
    ).bind(now, now, step.run_id, TAHA_WORKSPACE_ID),
    db.prepare(
      `UPDATE automation_steps SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'failed' AND lease_owner = ?
         AND lease_expires_at > ?
         AND EXISTS (
           SELECT 1 FROM automation_runs r
           WHERE r.id = automation_steps.run_id AND r.workspace_id = automation_steps.workspace_id
             AND r.status = 'failed'
         )`,
    ).bind(now, step.id, TAHA_WORKSPACE_ID, workerId, now),
  ]);
  if (changes(failed[0]) === 0 || changes(failed[1]) === 0 || changes(failed[3]) === 0) {
    return { state: "skipped" as const, code: "AUTOMATION_LEASE_LOST" };
  }
  return { state: "failed" as const, code };
}

export async function runAutomationWorker(options: {
  database?: AutomationDatabase;
  now?: number;
  limit?: number;
  workerId?: string;
} = {}): Promise<AutomationWorkerResult> {
  const db = database(options.database);
  const now = Math.floor(options.now ?? Date.now());
  const limit = Math.max(1, Math.min(3, Math.floor(options.limit ?? 1)));
  const workerId = options.workerId ?? crypto.randomUUID();
  await db.prepare(
    `UPDATE automation_steps SET status = 'retry_wait', available_at = ?, lease_owner = NULL,
     lease_expires_at = NULL, error_code = 'LEASE_EXPIRED_RETRY', updated_at = ?
     WHERE status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
  ).bind(now, now, now).run();
  const candidates = await db.prepare(
    `SELECT s.id, s.workspace_id, s.run_id, s.step_type, s.ordinal, s.status, s.available_at,
            s.attempt_count, s.max_attempts, s.result_json
     FROM automation_steps s JOIN automation_runs r ON r.id = s.run_id AND r.workspace_id = s.workspace_id
     WHERE s.workspace_id = ? AND s.status IN ('queued', 'retry_wait') AND s.available_at <= ?
       AND r.status IN ('queued', 'processing')
     ORDER BY CASE s.step_type WHEN 'content' THEN 0 WHEN 'image' THEN 1 ELSE 2 END,
              s.available_at, r.created_at, s.ordinal LIMIT 20`,
  ).bind(TAHA_WORKSPACE_ID, now).all<StepRow>();
  const summary: AutomationWorkerResult = {
    checked: 0,
    leased: 0,
    completed: 0,
    retrying: 0,
    failed: 0,
    skipped: 0,
    errors: [],
    processedAt: now,
  };
  for (const step of candidates.results ?? []) {
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
  return summary;
}
