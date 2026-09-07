import { editProductImage, generateProductContent } from "./ai/openai";
import { compressImageToJpeg, GENERATED_IMAGE_MAX_BYTES, LIFESTYLE_PROMPT_VERSION } from "./image-compression";
import { mediaBlob } from "./media";
import { syncGoogleCatalog } from "./integrations/google-sync";
import { getRuntimeEnv } from "./integrations/env";
import { verifyFacebookConnection } from "./integrations/facebook-permissions";
import { ensureWorkspace, TAHA_WORKSPACE_ID } from "./integrations/store";
import { assertGeneratedProductMedia, assertProductMedia, productFingerprint, productSourceConnection, productSources } from "./product-integrity";
import { findOrPersistGeneratedImage, LIFESTYLE_VARIANTS, normalizeProductSourceImages } from "./product-image-processing";

export const AUTOMATION_TARGET_PROVIDERS = [
  "facebook",
  "zalo_personal",
  "website",
  "tiktok_shop",
  "shopee",
] as const;

type TargetProvider = (typeof AUTOMATION_TARGET_PROVIDERS)[number];
type StepType = "content" | "optimize" | "image" | "finalize";
const AUTOMATION_LEASE_MS = 15 * 60_000;
const LEGACY_PROMPT_VERSION = "taha-drive-only-v2";
const MAX_AUTOMATION_SOURCE_IMAGES = 20;

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

export type QueueAutomationInput = {
  productId?: unknown;
  sourceMediaId?: unknown;
  idempotencyKey?: unknown;
  imageCount?: unknown;
  targetProviders?: unknown;
  connectionIds?: unknown;
  prepareOnly?: unknown;
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
  input: { productId: string; mediaId: string; imageCount: number; targetProviders: TargetProvider[]; targetConnections: Record<string, string>; prepareOnly: boolean },
) {
  const existingContent = json<Record<string, unknown>>(existing.content_json, {});
  const existingConnections = record(existingContent.targetConnections);
  return existing.product_id === input.productId
    && Object.keys(existingConnections).length === Object.keys(input.targetConnections).length
    && Object.entries(input.targetConnections).every(([key, value]) => existingConnections[key] === value)
    && existing.source_media_id === input.mediaId
    && existing.requested_image_count === input.imageCount
    && (existingContent.prepareOnly === true) === input.prepareOnly
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
  if (input.prepareOnly !== undefined && typeof input.prepareOnly !== "boolean") throw new AutomationError("INVALID_AUTOMATION_INPUT", "prepareOnly không hợp lệ.");
  const prepareOnly = input.prepareOnly === true;
  if (input.imageCount !== undefined && input.imageCount !== 0 && input.imageCount !== LIFESTYLE_VARIANTS.length) {
    throw new AutomationError("IMAGE_COUNT_INVALID", "Mỗi SKU phải dùng đúng 4 ảnh phong cách.");
  }
  const imageCount = input.imageCount === 0 ? 0 : LIFESTYLE_VARIANTS.length;
  const promptVersion = imageCount === LIFESTYLE_VARIANTS.length ? LIFESTYLE_PROMPT_VERSION : LEGACY_PROMPT_VERSION;
  const targetProviders = normalizeTargets(input.targetProviders);
  const targetConnections: Record<string, string> = {};
  const requestedConnections = record(input.connectionIds);
  for (const provider of prepareOnly ? [] : targetProviders.filter((p) => ["facebook", "website", "zalo_personal"].includes(p))) {
    const rows = await db.prepare(`SELECT id FROM channel_connections WHERE workspace_id = ? AND provider = ? AND status = 'connected' AND publish_mode = ?`)
      .bind(TAHA_WORKSPACE_ID, provider, provider === "zalo_personal" ? "assisted" : "api").all<{ id: string }>();
    const candidates = (rows.results ?? []).filter((row) => !requestedConnections[provider] || requestedConnections[provider] === row.id);
    if (candidates.length !== 1) throw new AutomationError("PUBLISH_CONNECTION_REQUIRED", `Kênh ${provider} cần đúng một tài khoản đích đang kết nối; hãy chọn tài khoản tại Kết nối.`, 409);
    targetConnections[provider] = candidates[0].id;
  }
  const sources = await productSources(productId, db);
  const mediaId = cleanText(input.sourceMediaId, 120) || sources.images[0].id;
  await assertProductMedia(productId, [mediaId], undefined, db);
  if (!getRuntimeEnv().OPENAI_API_KEY?.trim()) throw new AutomationError("OPENAI_CONFIG_MISSING", "Máy chủ chưa cấu hình dịch vụ viết bài AI.", 503);

  const existing = await db.prepare(
    `SELECT * FROM automation_runs WHERE workspace_id = ? AND request_key = ? LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID, requestKey).first<RunRow>();
  if (existing) {
    if (!isSameAutomationRequest(existing, { productId, mediaId, imageCount, targetProviders, targetConnections, prepareOnly })) {
      throw new AutomationError("IDEMPOTENCY_KEY_REUSED", "Khóa chống trùng đã được dùng cho yêu cầu khác.", 409);
    }
    return { run: publicRun(existing), replayed: true };
  }

  if (await activeAutomationRun(db, productId)) throw automationAlreadyRunning();

  if (!prepareOnly && targetConnections.facebook) {
    const permissions = await verifyFacebookConnection(targetConnections.facebook);
    if (!permissions.ready) throw new AutomationError(permissions.code || "FACEBOOK_VERIFICATION_FAILED", permissions.message || "Facebook chưa có đủ quyền đăng bài. Hãy kiểm tra kết nối Page.", 409);
  }

  const now = Date.now();
  const runId = crypto.randomUUID();
  const statements: AutomationStatement[] = [
    db.prepare(
      `INSERT INTO automation_runs
       (id, workspace_id, product_id, source_media_id, request_key, status, requested_image_count,
        completed_image_count, target_providers_json, output_media_ids_json, prompt_version,
        created_by, created_at, updated_at, content_json)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, '[]', ?, ?, ?, ?, ?)`,
    ).bind(runId, TAHA_WORKSPACE_ID, productId, mediaId, requestKey, imageCount, JSON.stringify(targetProviders), promptVersion, actorId?.slice(0, 160) ?? "operator", now, now, JSON.stringify({ targetConnections, prepareOnly })),
    db.prepare(
      `INSERT INTO automation_steps
       (id, workspace_id, run_id, step_type, ordinal, status, available_at, attempt_count, max_attempts,
        result_json, created_at, updated_at)
       VALUES (?, ?, ?, 'content', 0, 'queued', ?, 0, 3, '{}', ?, ?)`,
    ).bind(await stableId("step", `${runId}:content:0`), TAHA_WORKSPACE_ID, runId, now, now, now),
  ];
  if (imageCount === LIFESTYLE_VARIANTS.length) {
    for (let ordinal = 0; ordinal < LIFESTYLE_VARIANTS.length; ordinal += 1) {
      statements.push(db.prepare(
        `INSERT INTO automation_steps
         (id, workspace_id, run_id, step_type, ordinal, status, available_at, attempt_count, max_attempts,
          result_json, created_at, updated_at)
         VALUES (?, ?, ?, 'image', ?, 'queued', ?, 0, 3, '{}', ?, ?)`,
      ).bind(await stableId("step", `${runId}:image:${ordinal}`), TAHA_WORKSPACE_ID, runId, ordinal, now, now, now));
    }
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
      if (!isSameAutomationRequest(racedExisting, { productId, mediaId, imageCount, targetProviders, targetConnections, prepareOnly })) {
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
     ORDER BY CASE step_type WHEN 'content' THEN 0 WHEN 'optimize' THEN 1 WHEN 'image' THEN 2 ELSE 3 END, ordinal`,
  ).bind(id, TAHA_WORKSPACE_ID).all<Record<string, unknown>>();
  const drafts = await db.prepare(
    `SELECT id, target_provider, content_type, title, body, hashtags_json, status, version, created_at
     FROM content_drafts WHERE workspace_id = ? AND json_extract(generation_meta_json, '$.automationRunId') = ?
     ORDER BY created_at, target_provider`,
  ).bind(TAHA_WORKSPACE_ID, id).all<Record<string, unknown>>();
  const schedules = await db.prepare(`SELECT s.id, s.draft_id, s.status, s.run_at, s.next_run_at, c.display_name, c.provider
    FROM schedules s JOIN channel_connections c ON c.id = s.connection_id
    WHERE s.workspace_id = ? AND s.created_by = ?`).bind(TAHA_WORKSPACE_ID, `automation:${id}`).all<Record<string, unknown>>();
  const jobs = await db.prepare(`SELECT j.id, j.status, j.external_post_id, j.external_url, j.error_code, j.error_message
    FROM publish_jobs j JOIN schedules s ON s.id = j.schedule_id
    WHERE j.workspace_id = ? AND s.created_by = ?`).bind(TAHA_WORKSPACE_ID, `automation:${id}`).all<Record<string, unknown>>();
  return { ...publicRun(row), steps: steps.results ?? [], drafts: drafts.results ?? [], schedules: schedules.results ?? [], jobs: jobs.results ?? [] };
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
    "SELECT status, requested_image_count, prompt_version FROM automation_runs WHERE id = ? AND workspace_id = ? LIMIT 1",
  ).bind(id, TAHA_WORKSPACE_ID).first<{ status: string; requested_image_count: number; prompt_version: string }>();
  if (!existing) throw new AutomationError("AUTOMATION_RUN_NOT_FOUND", "Không tìm thấy công việc AI.", 404);
  if (Number(existing.requested_image_count) !== 0
    && !(Number(existing.requested_image_count) === LIFESTYLE_VARIANTS.length && existing.prompt_version === LIFESTYLE_PROMPT_VERSION)) {
    throw new AutomationError("DRIVE_ONLY_RESTART_REQUIRED", "Hãy xác nhận lại sản phẩm để dùng luồng ảnh mới.", 409);
  }
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

function assertSourceSnapshot(sources: Awaited<ReturnType<typeof productSources>>, content: Record<string, unknown>) {
  const expected = Array.isArray(content.sourceMediaSnapshot) ? content.sourceMediaSnapshot.map(record) : [];
  if (expected.length !== sources.images.length || expected.length < 1) throw new Error("PRODUCT_MEDIA_MISMATCH");
  const current = new Map(sources.images.map((image) => {
    const metadata = json<Record<string, unknown>>(image.metadata_json, {});
    return [image.id, { externalId: image.external_id, sourceVersion: cleanText(metadata.md5Checksum || metadata.modifiedTime, 200) }];
  }));
  for (const item of expected) {
    const mediaId = cleanText(item.mediaId, 120);
    const match = current.get(mediaId);
    if (!match || match.externalId !== item.externalId || !match.sourceVersion || match.sourceVersion !== item.sourceVersion) {
      throw new Error("PRODUCT_MEDIA_MISMATCH");
    }
  }
}

async function processContent(db: AutomationDatabase, run: RunRow, step: StepRow, workerId: string, now: number) {
  await syncGoogleCatalog(await productSourceConnection(run.product_id, db));
  const sources = await productSources(run.product_id, db);
  if (sources.images.length > MAX_AUTOMATION_SOURCE_IMAGES) throw new Error("SKU_SOURCE_IMAGE_LIMIT_EXCEEDED");
  const product = sources.product;
  const fingerprint = await productFingerprint(product);
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
  const sourceSnapshots = sources.images.map((image) => {
    const metadata = json<Record<string, unknown>>(image.metadata_json, {});
    const sourceVersion = cleanText(metadata.md5Checksum || metadata.modifiedTime, 200);
    if (!sourceVersion) throw new Error("SOURCE_IMAGE_VERSION_MISSING");
    return { mediaId: image.id, externalId: image.external_id, sourceVersion };
  });
  const statements: AutomationStatement[] = [
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
      JSON.stringify({ ...json<Record<string, unknown>>(run.content_json, {}), ...generated.content, sourceFingerprint: fingerprint,
        sourceMediaIds: sources.images.slice(0, 10).map((image) => image.id), allSourceMediaIds: sources.images.map((image) => image.id),
        sourceMediaSnapshot: sourceSnapshots }),
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
  ];
  const completeContent = statements.pop();
  if (!completeContent) throw new Error("AUTOMATION_STEP_FAILED");
  for (const [ordinal, snapshot] of sourceSnapshots.entries()) {
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO automation_steps
       (id, workspace_id, run_id, step_type, ordinal, status, available_at, attempt_count, max_attempts,
        result_json, created_at, updated_at)
       SELECT ?, ?, ?, 'optimize', ?, 'queued', ?, 0, 3, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM automation_steps s WHERE s.id=? AND s.run_id=? AND s.workspace_id=?
         AND s.status='processing' AND s.lease_owner=? AND s.lease_expires_at > ?)`,
    ).bind(await stableId("step", `${run.id}:optimize:${snapshot.mediaId}`), TAHA_WORKSPACE_ID, run.id, ordinal,
      completedAt, JSON.stringify(snapshot), completedAt, completedAt, step.id, run.id, TAHA_WORKSPACE_ID, workerId, completedAt));
  }
  statements.push(completeContent);
  const saved = await db.batch(statements);
  if (changes(saved[0]) === 0 || changes(saved[saved.length - 1]) === 0) throw new Error("AUTOMATION_LEASE_LOST");
}

async function processOptimize(db: AutomationDatabase, run: RunRow, step: StepRow, workerId: string) {
  const content = json<Record<string, unknown>>(run.content_json, {});
  if (typeof content.sourceFingerprint !== "string") throw new Error("AUTOMATION_PREREQUISITES_PENDING");
  const snapshot = json<Record<string, unknown>>(step.result_json, {});
  const mediaId = cleanText(snapshot.mediaId, 120);
  const externalId = cleanText(snapshot.externalId, 160);
  const expectedVersion = cleanText(snapshot.sourceVersion, 200);
  const sources = await productSources(run.product_id, db);
  if (content.sourceFingerprint !== await productFingerprint(sources.product)) throw new Error("PRODUCT_CONTENT_STALE");
  assertSourceSnapshot(sources, content);
  const source = sources.images.find((image) => image.id === mediaId);
  const metadata = source ? json<Record<string, unknown>>(source.metadata_json, {}) : {};
  const currentVersion = cleanText(metadata.md5Checksum || metadata.modifiedTime, 200);
  if (!source || source.external_id !== externalId || !expectedVersion || currentVersion !== expectedVersion) {
    throw new Error("PRODUCT_MEDIA_MISMATCH");
  }
  await normalizeProductSourceImages(run.product_id, [mediaId]);
  const completedAt = Date.now();
  const completed = await db.prepare(
    `UPDATE automation_steps SET status='completed', result_json=?, lease_owner=NULL, lease_expires_at=NULL,
     completed_at=?, updated_at=? WHERE id=? AND workspace_id=? AND status='processing' AND lease_owner=?
       AND lease_expires_at > ? AND EXISTS (SELECT 1 FROM automation_runs r WHERE r.id=automation_steps.run_id
         AND r.workspace_id=automation_steps.workspace_id AND r.status IN ('queued','processing'))`,
  ).bind(JSON.stringify({ mediaId, externalId, sourceVersion: expectedVersion, optimized: true }), completedAt, completedAt,
    step.id, TAHA_WORKSPACE_ID, workerId, completedAt).run();
  if (changes(completed) === 0) throw new Error("AUTOMATION_LEASE_LOST");
}

async function processImage(db: AutomationDatabase, run: RunRow, step: StepRow, workerId: string) {
  if (run.requested_image_count !== LIFESTYLE_VARIANTS.length || run.prompt_version !== LIFESTYLE_PROMPT_VERSION) {
    throw new Error("LEGACY_IMAGE_RUN_DISABLED");
  }
  const variant = LIFESTYLE_VARIANTS[step.ordinal];
  if (!variant) throw new Error("IMAGE_VARIANT_INVALID");
  const content = json<Record<string, unknown>>(run.content_json, {});
  if (typeof content.sourceFingerprint !== "string") throw new Error("AUTOMATION_PREREQUISITES_PENDING");
  const sources = await productSources(run.product_id, db);
  if (content.sourceFingerprint !== await productFingerprint(sources.product)) throw new Error("PRODUCT_CONTENT_STALE");
  assertSourceSnapshot(sources, content);
  const source = sources.images.find((image) => image.id === run.source_media_id);
  if (!source) throw new Error("PRODUCT_MEDIA_MISMATCH");

  let saved = await findOrPersistGeneratedImage({
    productId: run.product_id,
    source,
    sourceFingerprint: content.sourceFingerprint,
    variant,
    promptVersion: run.prompt_version,
  });
  let model: string | null = null;
  if (!saved) {
    const loaded = await mediaBlob(source.id, 25 * 1024 * 1024);
    const edited = await editProductImage({
      source: loaded.blob,
      mimeType: loaded.mimeType,
      filename: loaded.filename,
      product: { sku: sources.product.base_sku, name: sources.product.name },
      layoutIndex: step.ordinal + 1,
    });
    const compressed = await compressImageToJpeg(edited.image, GENERATED_IMAGE_MAX_BYTES);
    saved = await findOrPersistGeneratedImage({
      productId: run.product_id,
      source,
      sourceFingerprint: content.sourceFingerprint,
      variant,
      promptVersion: run.prompt_version,
      model: edited.model,
      blob: compressed.blob,
      width: compressed.width,
      height: compressed.height,
    });
    model = edited.model;
  }
  if (!saved) throw new Error("PRODUCT_DRIVE_MEDIA_WRITE_FAILED");
  model ??= cleanText(record(saved.metadata).generation && record(record(saved.metadata).generation).model, 200) || null;
  const completedAt = Date.now();
  const committed = await db.batch([
    db.prepare(
      `UPDATE automation_steps SET status='completed', result_json=?, lease_owner=NULL, lease_expires_at=NULL,
       completed_at=?, updated_at=? WHERE id=? AND workspace_id=? AND status='processing' AND lease_owner=?
       AND lease_expires_at > ? AND EXISTS (SELECT 1 FROM automation_runs r WHERE r.id=automation_steps.run_id
         AND r.workspace_id=automation_steps.workspace_id AND r.status IN ('queued','processing'))`,
    ).bind(JSON.stringify({ mediaId: saved.mediaId, variant }), completedAt, completedAt, step.id, TAHA_WORKSPACE_ID, workerId, completedAt),
    db.prepare(
      `UPDATE automation_runs SET completed_image_count=(SELECT COUNT(*) FROM automation_steps s
         WHERE s.run_id=automation_runs.id AND s.workspace_id=automation_runs.workspace_id
           AND s.step_type='image' AND s.status='completed'),
       image_model=COALESCE(?, image_model), status='processing', updated_at=?
       WHERE id=? AND workspace_id=? AND status IN ('queued','processing')
         AND EXISTS (SELECT 1 FROM automation_steps s WHERE s.id=? AND s.run_id=automation_runs.id
           AND s.workspace_id=automation_runs.workspace_id AND s.status='completed')`,
    ).bind(model, completedAt, run.id, TAHA_WORKSPACE_ID, step.id),
  ]);
  if (changes(committed[0]) === 0 || changes(committed[1]) === 0) throw new Error("AUTOMATION_LEASE_LOST");
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

function publicationDayFromRequestKey(requestKey: string) {
  const match = /^daily:(\d{4})-(\d{2})-(\d{2}):/.exec(requestKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  return { year, month, day };
}

function nextLocalSlot(now: number, hour: number, requestKey?: string) {
  if (requestKey?.startsWith("trial:")) return now + 5 * 60_000;
  const offset = 7 * 60 * 60 * 1_000;
  const targetDay = requestKey ? publicationDayFromRequestKey(requestKey) : null;
  if (targetDay) {
    const planned = Date.UTC(targetDay.year, targetDay.month - 1, targetDay.day, hour, 0) - offset;
    // If a daily run finishes late, publish shortly after completion rather than silently rolling
    // the content into another calendar day. Normal runs are prepared before their target day.
    return planned <= now + 5 * 60 * 1_000 ? now + 5 * 60 * 1_000 : planned;
  }
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
     AND step_type IN ('content', 'optimize', 'image') AND status != 'completed'`,
  ).bind(run.id, TAHA_WORKSPACE_ID).first<{ total: number }>();
  if (Number(incomplete?.total ?? 0) > 0) throw new Error("AUTOMATION_PREREQUISITES_PENDING");
  const content = json<Record<string, unknown>>(current.content_json, {});
  const originalMediaIds = Array.isArray(content.sourceMediaIds) ? content.sourceMediaIds.filter((id): id is string => typeof id === "string") : [];
  if (typeof content.sourceFingerprint !== "string") throw new Error("PRODUCT_CONTENT_STALE");
  const sources = await assertProductMedia(run.product_id, originalMediaIds, content.sourceFingerprint, db);
  assertSourceSnapshot(sources, content);
  let mediaIds: string[] = [];
  if (current.requested_image_count === LIFESTYLE_VARIANTS.length) {
    if (current.prompt_version !== LIFESTYLE_PROMPT_VERSION) throw new Error("LEGACY_IMAGE_RUN_DISABLED");
    const imageSteps = await db.prepare(`SELECT ordinal, result_json FROM automation_steps
      WHERE run_id=? AND workspace_id=? AND step_type='image' AND status='completed' ORDER BY ordinal`)
      .bind(run.id, TAHA_WORKSPACE_ID).all<{ ordinal: number; result_json: string }>();
    if ((imageSteps.results ?? []).length !== LIFESTYLE_VARIANTS.length
      || (imageSteps.results ?? []).some((item, index) => item.ordinal !== index)) throw new Error("AUTOMATION_PREREQUISITES_PENDING");
    mediaIds = (imageSteps.results ?? []).map((item) => cleanText(record(json<Record<string, unknown>>(item.result_json, {})).mediaId, 120));
    await assertGeneratedProductMedia(run.product_id, mediaIds, content.sourceFingerprint, current.prompt_version, LIFESTYLE_VARIANTS, db);
  } else if (current.requested_image_count !== 0) {
    throw new Error("LEGACY_IMAGE_RUN_DISABLED");
  }
  const draftMediaIds = mediaIds.length ? mediaIds : originalMediaIds;
  const prepareOnly = content.prepareOnly === true;
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
      sku: sources.sku,
      sourceFingerprint: content.sourceFingerprint,
      imagePromptVersion: current.prompt_version,
      productDescription: cleanText(content.productDescription, 20_000),
      sourceImageCount: originalMediaIds.length,
      generatedImageCount: mediaIds.length,
      totalImageCount: draftMediaIds.length,
    };
    statements.push(db.prepare(
      `INSERT INTO content_drafts
       (id, workspace_id, product_id, target_provider, content_type, language, title, body,
        hashtags_json, platform_data_json, status, version, generator, model, prompt_version,
        generation_meta_json, approved_by, approved_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'vi', ?, ?, ?, ?, ?, 1, 'openai', ?, ?, ?, ?, ?, ?, ?
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
      prepareOnly ? "draft" : "approved",
      current.text_model,
      current.prompt_version,
      JSON.stringify({ automationRunId: run.id, sourceMediaIds: originalMediaIds, outputMediaIds: mediaIds, allMediaIds: draftMediaIds }),
      prepareOnly ? null : `automation:${run.id}`,
      prepareOnly ? null : finalizedAt,
      finalizedAt,
      finalizedAt,
      run.id,
      TAHA_WORKSPACE_ID,
      step.id,
      workerId,
      finalizedAt,
    ));
    for (let index = 0; index < draftMediaIds.length; index += 1) {
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
        await stableId("cdm", `${draftId}:${draftMediaIds[index]}`),
        TAHA_WORKSPACE_ID,
        draftId,
        draftMediaIds[index],
        index === 0 ? "primary" : mediaIds.length ? "attachment" : "source",
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
    if (!prepareOnly && scheduleHour !== undefined) {
      const connection = await db.prepare(
        `SELECT id, publish_mode FROM channel_connections
         WHERE workspace_id = ? AND provider = ? AND status = 'connected' AND id = ? LIMIT 1`,
      ).bind(TAHA_WORKSPACE_ID, provider, record(content.targetConnections)[provider] ?? "").first<{ id: string; publish_mode: string }>();
      if (!connection || connection.publish_mode !== (provider === "zalo_personal" ? "assisted" : "api")) throw new Error("PUBLISH_CONNECTION_REQUIRED");
      if (connection) {
        const scheduleId = await stableId("schedule", `${run.id}:${provider}`);
        scheduleIds.push(scheduleId);
        const runAt = nextLocalSlot(now, scheduleHour, current.request_key);
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
  runIds?: string[];
} = {}): Promise<AutomationWorkerResult> {
  const db = database(options.database);
  const now = Math.floor(options.now ?? Date.now());
  const limit = Math.max(1, Math.min(8, Math.floor(options.limit ?? 4)));
  const workerId = options.workerId ?? crypto.randomUUID();
  const runIds = options.runIds;
  if (runIds !== undefined && (!Array.isArray(runIds) || runIds.length < 1 || runIds.length > 50
    || new Set(runIds).size !== runIds.length
    || runIds.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)))) {
    throw new Error("AUTOMATION_RUN_FILTER_INVALID");
  }
  const runFilter = runIds ? ` AND r.id IN (${runIds.map(() => "?").join(",")})` : "";
  const stepRunFilter = runIds ? ` AND run_id IN (${runIds.map(() => "?").join(",")})` : "";
  await db.prepare(
    `UPDATE automation_steps SET status = 'retry_wait', available_at = ?, lease_owner = NULL,
     lease_expires_at = NULL, error_code = 'LEASE_EXPIRED_RETRY', updated_at = ?
     WHERE workspace_id = ? AND status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
       ${stepRunFilter}`,
  ).bind(now, now, TAHA_WORKSPACE_ID, now, ...(runIds ?? [])).run();
  const candidates = await db.prepare(
    `SELECT s.id, s.workspace_id, s.run_id, s.step_type, s.ordinal, s.status, s.available_at,
            s.attempt_count, s.max_attempts, s.result_json
     FROM automation_steps s JOIN automation_runs r ON r.id = s.run_id AND r.workspace_id = s.workspace_id
     WHERE s.workspace_id = ? AND s.status IN ('queued', 'retry_wait') AND s.available_at <= ?
       AND r.status IN ('queued', 'processing') AND s.step_type IN ('content', 'optimize', 'image', 'finalize')
       ${runFilter}
       AND (s.step_type = 'content'
         OR (s.step_type = 'optimize' AND NOT EXISTS (
           SELECT 1 FROM automation_steps prior WHERE prior.run_id=s.run_id AND prior.workspace_id=s.workspace_id
             AND prior.step_type='content' AND prior.status != 'completed'
         ))
         OR (s.step_type = 'image' AND NOT EXISTS (
           SELECT 1 FROM automation_steps prior WHERE prior.run_id=s.run_id AND prior.workspace_id=s.workspace_id
             AND prior.step_type IN ('content','optimize') AND prior.status != 'completed'
         ))
         OR (s.step_type = 'finalize' AND NOT EXISTS (
           SELECT 1 FROM automation_steps prior WHERE prior.run_id=s.run_id AND prior.workspace_id=s.workspace_id
             AND prior.step_type IN ('content','optimize','image') AND prior.status != 'completed'
         )))
     ORDER BY r.created_at,
              CASE s.step_type WHEN 'content' THEN 0 WHEN 'optimize' THEN 1 WHEN 'image' THEN 2 ELSE 3 END,
              s.available_at, s.ordinal, s.id LIMIT 20`,
  ).bind(TAHA_WORKSPACE_ID, now, ...(runIds ?? [])).all<StepRow>();
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
  const claimed: Array<{ step: StepRow; lease: { attempt_count: number; max_attempts: number } }> = [];
  for (const step of candidates.results ?? []) {
    if (claimed.length >= limit) break;
    summary.checked += 1;
    if ((step.step_type === "optimize" || step.step_type === "image")
      && claimed.some((item) => item.step.step_type === "optimize" || item.step.step_type === "image")) {
      summary.skipped += 1;
      continue;
    }
    if (step.step_type === "optimize" || step.step_type === "image" || step.step_type === "finalize") {
      const pending = await db.prepare(
        `SELECT COUNT(*) AS total FROM automation_steps WHERE run_id = ? AND workspace_id = ?
         AND step_type IN (${step.step_type === "optimize" ? "'content'" : step.step_type === "image" ? "'content','optimize'" : "'content','optimize','image'"}) AND status != 'completed'`,
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
      else if (step.step_type === "optimize") await processOptimize(db, run, step, stepWorkerId);
      else if (step.step_type === "image") await processImage(db, run, step, stepWorkerId);
      else await processFinalize(db, run, step, stepWorkerId, now);
      summary.completed += 1;
    } catch (error) {
      const transition = await retryOrFail(db, step, lease, stepWorkerId, error, Date.now());
      summary[transition.state] += 1;
      summary.errors.push({ stepId: step.id, code: transition.code });
    }
  }));
  return summary;
}
