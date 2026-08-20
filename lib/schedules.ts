import { getRuntimeEnv } from "./integrations/env";
import { TAHA_WORKSPACE_ID } from "./integrations/store";
import { nextScheduledOccurrence, TAHA_SCHEDULER_TIMEZONE } from "./scheduler";

const scheduleKinds = ["once", "daily", "weekly"] as const;
const executionModes = ["inherit", "auto", "assisted"] as const;
const scheduleStatuses = ["draft", "active", "paused", "completed", "cancelled"] as const;

type ScheduleKind = (typeof scheduleKinds)[number];
type ExecutionMode = (typeof executionModes)[number];
type ScheduleStatus = (typeof scheduleStatuses)[number];

type ScheduleRow = {
  id: string;
  workspace_id: string;
  draft_id: string;
  connection_id: string;
  status: ScheduleStatus;
  schedule_kind: ScheduleKind;
  run_at: number | null;
  local_time: string | null;
  weekdays_json: string | null;
  timezone: string;
  next_run_at: number | null;
  last_run_at: number | null;
  ends_at: number | null;
  execution_mode: ExecutionMode;
  publish_options_json: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  draft_title?: string | null;
  target_provider?: string;
  connection_name?: string;
  provider?: string;
  publish_mode?: string;
};

type ValidatedResources = {
  provider: string;
  publishMode: string;
};

type CreateScheduleInput = {
  idempotencyKey: string;
  draftId: string;
  connectionId: string;
  scheduleKind: ScheduleKind;
  runAt: number | null;
  localTime: string | null;
  weekdays: number[];
  timezone: typeof TAHA_SCHEDULER_TIMEZONE;
  endsAt: number | null;
  executionMode: ExecutionMode;
  publishOptions: Record<string, unknown>;
};

export class ScheduleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ScheduleError";
  }
}

function database() {
  const value = getRuntimeEnv().DB;
  if (!value) {
    throw new ScheduleError("DATABASE_UNAVAILABLE", "Cơ sở dữ liệu lịch đăng chưa sẵn sàng.", 503);
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ScheduleError("INVALID_REQUEST", "Dữ liệu lịch đăng không hợp lệ.", 422);
  }
  return value as Record<string, unknown>;
}

function requiredId(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 160) {
    throw new ScheduleError("INVALID_REQUEST", `${field} không hợp lệ.`, 422);
  }
  return value.trim();
}

function optionalTimestamp(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ScheduleError("INVALID_REQUEST", `${field} không hợp lệ.`, 422);
  }
  return parsed;
}

function localTime(value: unknown) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(value)) {
    throw new ScheduleError("INVALID_LOCAL_TIME", "Giờ đăng phải có định dạng HH:mm.", 422);
  }
  return value;
}

function normalizedWeekdays(value: unknown) {
  if (!Array.isArray(value)) {
    throw new ScheduleError("INVALID_WEEKDAYS", "Danh sách thứ đăng bài không hợp lệ.", 422);
  }
  const days = new Set<number>();
  for (const item of value) {
    if (!Number.isInteger(item) || Number(item) < 0 || Number(item) > 7) {
      throw new ScheduleError("INVALID_WEEKDAYS", "Mỗi thứ phải nằm trong khoảng 0 đến 7.", 422);
    }
    days.add(Number(item) === 7 ? 0 : Number(item));
  }
  return [...days].sort((left, right) => left - right);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseCreateInput(value: unknown, now: number): CreateScheduleInput {
  const body = objectValue(value);
  const idempotencyKey = requiredId(body.idempotencyKey, "Mã chống tạo trùng");
  if (idempotencyKey.length < 8) {
    throw new ScheduleError("INVALID_IDEMPOTENCY_KEY", "Mã chống tạo trùng phải có ít nhất 8 ký tự.", 422);
  }
  const draftId = requiredId(body.draftId, "Nội dung");
  const connectionId = requiredId(body.connectionId, "Kết nối kênh");
  if (!scheduleKinds.includes(body.scheduleKind as ScheduleKind)) {
    throw new ScheduleError("INVALID_SCHEDULE_KIND", "Kiểu lịch đăng không hợp lệ.", 422);
  }
  const scheduleKind = body.scheduleKind as ScheduleKind;
  const timezone = body.timezone ?? TAHA_SCHEDULER_TIMEZONE;
  if (timezone !== TAHA_SCHEDULER_TIMEZONE) {
    throw new ScheduleError("UNSUPPORTED_TIMEZONE", "Phiên bản này chỉ hỗ trợ múi giờ Asia/Ho_Chi_Minh.", 422);
  }
  const executionMode = body.executionMode ?? "inherit";
  if (!executionModes.includes(executionMode as ExecutionMode)) {
    throw new ScheduleError("INVALID_EXECUTION_MODE", "Chế độ xuất bản không hợp lệ.", 422);
  }
  const publishOptions = body.publishOptions === undefined ? {} : objectValue(body.publishOptions);
  const endsAt = optionalTimestamp(body.endsAt, "Thời điểm kết thúc");

  let runAt: number | null = null;
  let normalizedLocalTime: string | null = null;
  let weekdays: number[] = [];
  if (scheduleKind === "once") {
    runAt = optionalTimestamp(body.runAt, "Thời điểm đăng");
    if (runAt == null) throw new ScheduleError("RUN_AT_REQUIRED", "Lịch một lần cần thời điểm đăng.", 422);
    if (runAt <= now) throw new ScheduleError("RUN_AT_IN_PAST", "Thời điểm đăng phải ở tương lai.", 422);
  } else {
    normalizedLocalTime = localTime(body.localTime);
    if (scheduleKind === "weekly") {
      weekdays = normalizedWeekdays(body.weekdays);
      if (weekdays.length === 0) {
        throw new ScheduleError("INVALID_WEEKDAYS", "Lịch hàng tuần cần ít nhất một thứ.", 422);
      }
    } else if (body.weekdays !== undefined && normalizedWeekdays(body.weekdays).length > 0) {
      throw new ScheduleError("INVALID_WEEKDAYS", "Lịch hàng ngày không dùng danh sách thứ.", 422);
    }
  }

  const firstRun = scheduleKind === "once"
    ? runAt
    : nextScheduledOccurrence({
        scheduleKind,
        localTime: normalizedLocalTime,
        weekdays,
        timezone,
        endsAt,
      }, now);
  if (endsAt != null && (endsAt <= now || (firstRun != null && endsAt < firstRun))) {
    throw new ScheduleError("INVALID_ENDS_AT", "Thời điểm kết thúc phải sau lần đăng đầu tiên.", 422);
  }
  if (firstRun == null) {
    throw new ScheduleError("SCHEDULE_ENDED", "Lịch này không còn lần chạy hợp lệ.", 422);
  }

  return {
    idempotencyKey,
    draftId,
    connectionId,
    scheduleKind,
    runAt,
    localTime: normalizedLocalTime,
    weekdays,
    timezone,
    endsAt,
    executionMode: executionMode as ExecutionMode,
    publishOptions,
  };
}

async function scheduleIdFor(idempotencyKey: string) {
  const input = new TextEncoder().encode(`${TAHA_WORKSPACE_ID}:${idempotencyKey}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `schedule_${[...digest].map((value) => value.toString(16).padStart(2, "0")).join("").slice(0, 40)}`;
}

async function scheduleRow(id: string) {
  return database().prepare(
    `SELECT id, workspace_id, draft_id, connection_id, status, schedule_kind, run_at, local_time,
            weekdays_json, timezone, next_run_at, last_run_at, ends_at, execution_mode,
            publish_options_json, created_by, created_at, updated_at
     FROM schedules WHERE id = ? AND workspace_id = ? LIMIT 1`,
  ).bind(id, TAHA_WORKSPACE_ID).first<ScheduleRow>();
}

function scheduleDto(row: ScheduleRow) {
  return {
    id: row.id,
    draftId: row.draft_id,
    connectionId: row.connection_id,
    status: row.status,
    scheduleKind: row.schedule_kind,
    runAt: row.run_at,
    localTime: row.local_time,
    weekdays: parseJson<number[]>(row.weekdays_json, []),
    timezone: row.timezone,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    endsAt: row.ends_at,
    executionMode: row.execution_mode,
    publishOptions: parseJson<Record<string, unknown>>(row.publish_options_json, {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.draft_title === undefined ? {} : { draftTitle: row.draft_title }),
    ...(row.target_provider === undefined ? {} : { targetProvider: row.target_provider }),
    ...(row.connection_name === undefined ? {} : { connectionName: row.connection_name }),
    ...(row.provider === undefined ? {} : { provider: row.provider }),
    ...(row.publish_mode === undefined ? {} : { publishMode: row.publish_mode }),
  };
}

async function validateResources(draftId: string, connectionId: string): Promise<ValidatedResources> {
  const db = database();
  const draft = await db.prepare(
    `SELECT id, status, target_provider FROM content_drafts
     WHERE id = ? AND workspace_id = ? AND archived_at IS NULL LIMIT 1`,
  ).bind(draftId, TAHA_WORKSPACE_ID).first<{ id: string; status: string; target_provider: string }>();
  if (!draft) throw new ScheduleError("DRAFT_NOT_FOUND", "Không tìm thấy nội dung trong workspace này.", 404);
  if (draft.status !== "approved") {
    throw new ScheduleError("DRAFT_NOT_APPROVED", "Nội dung phải được duyệt trước khi lên lịch.", 409);
  }

  const media = await db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN media_assets.status = 'ready' THEN 0 ELSE 1 END) AS not_ready
     FROM content_draft_media
     JOIN media_assets ON media_assets.id = content_draft_media.media_id
                      AND media_assets.workspace_id = content_draft_media.workspace_id
     WHERE content_draft_media.workspace_id = ? AND content_draft_media.draft_id = ?`,
  ).bind(TAHA_WORKSPACE_ID, draftId).first<{ total: number; not_ready: number | null }>();
  if (!media || Number(media.total) < 1) {
    throw new ScheduleError("MEDIA_REQUIRED", "Nội dung cần ít nhất một ảnh hoặc video trước khi lên lịch.", 409);
  }
  if (Number(media.not_ready ?? 0) > 0) {
    throw new ScheduleError("MEDIA_NOT_READY", "Tất cả ảnh và video phải xử lý xong trước khi lên lịch.", 409);
  }

  const connection = await db.prepare(
    `SELECT provider, status, role, publish_mode FROM channel_connections
     WHERE id = ? AND workspace_id = ? LIMIT 1`,
  ).bind(connectionId, TAHA_WORKSPACE_ID).first<{
    provider: string;
    status: string;
    role: string;
    publish_mode: string;
  }>();
  if (!connection) throw new ScheduleError("CONNECTION_NOT_FOUND", "Không tìm thấy kết nối kênh trong workspace này.", 404);
  if (connection.status !== "connected") {
    throw new ScheduleError("CONNECTION_NOT_CONNECTED", "Kênh phải được kết nối trước khi lên lịch.", 409);
  }
  if (connection.role === "source" || connection.publish_mode === "export_only") {
    throw new ScheduleError("CONNECTION_NOT_PUBLISHER", "Kết nối này không có quyền xuất bản.", 409);
  }
  if (draft.target_provider !== connection.provider) {
    throw new ScheduleError("PROVIDER_MISMATCH", "Nội dung và kênh xuất bản không cùng nền tảng.", 409);
  }
  return { provider: connection.provider, publishMode: connection.publish_mode };
}

function sameSchedule(row: ScheduleRow, input: CreateScheduleInput, executionMode: ExecutionMode) {
  return row.draft_id === input.draftId &&
    row.connection_id === input.connectionId &&
    row.schedule_kind === input.scheduleKind &&
    row.run_at === input.runAt &&
    row.local_time === input.localTime &&
    canonicalJson(parseJson<number[]>(row.weekdays_json, [])) === canonicalJson(input.weekdays) &&
    row.timezone === input.timezone &&
    row.ends_at === input.endsAt &&
    row.execution_mode === executionMode &&
    canonicalJson(parseJson<Record<string, unknown>>(row.publish_options_json, {})) === canonicalJson(input.publishOptions);
}

export async function createSchedule(value: unknown, actorId: string | null, now = Date.now()) {
  const input = parseCreateInput(value, now);
  const resources = await validateResources(input.draftId, input.connectionId);
  const executionMode = resources.provider === "zalo_personal" ? "assisted" : input.executionMode;
  const id = await scheduleIdFor(input.idempotencyKey);
  const existing = await scheduleRow(id);
  if (existing) {
    if (!sameSchedule(existing, input, executionMode)) {
      throw new ScheduleError("IDEMPOTENCY_KEY_REUSED", "Mã chống tạo trùng đã được dùng cho một lịch khác.", 409);
    }
    return { schedule: scheduleDto(existing), replay: true };
  }

  const result = await database().prepare(
    `INSERT INTO schedules
     (id, workspace_id, draft_id, connection_id, status, schedule_kind, run_at, local_time,
      weekdays_json, timezone, next_run_at, last_run_at, ends_at, execution_mode,
      publish_options_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(
    id,
    TAHA_WORKSPACE_ID,
    input.draftId,
    input.connectionId,
    input.scheduleKind,
    input.runAt,
    input.localTime,
    canonicalJson(input.weekdays),
    input.timezone,
    input.endsAt,
    executionMode,
    canonicalJson(input.publishOptions),
    actorId?.slice(0, 160) ?? "operator",
    now,
    now,
  ).run();
  const created = await scheduleRow(id);
  if (!created) throw new ScheduleError("SCHEDULE_CREATE_FAILED", "Không thể lưu lịch đăng.", 500);
  if (!sameSchedule(created, input, executionMode)) {
    throw new ScheduleError("IDEMPOTENCY_KEY_REUSED", "Mã chống tạo trùng đã được dùng cho một lịch khác.", 409);
  }
  const replay = Number((result.meta as { changes?: number } | undefined)?.changes ?? 0) === 0;
  return { schedule: scheduleDto(created), replay };
}

export async function listSchedules(status?: string | null, limitValue?: string | null) {
  if (status && !scheduleStatuses.includes(status as ScheduleStatus)) {
    throw new ScheduleError("INVALID_STATUS", "Trạng thái lịch không hợp lệ.", 422);
  }
  const parsedLimit = limitValue == null ? 50 : Number(limitValue);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
    throw new ScheduleError("INVALID_LIMIT", "Giới hạn danh sách không hợp lệ.", 422);
  }
  const limit = Math.min(100, parsedLimit);
  const fields = `SELECT s.id, s.workspace_id, s.draft_id, s.connection_id, s.status, s.schedule_kind,
                          s.run_at, s.local_time, s.weekdays_json, s.timezone, s.next_run_at,
                          s.last_run_at, s.ends_at, s.execution_mode, s.publish_options_json,
                          s.created_by, s.created_at, s.updated_at, d.title AS draft_title,
                          d.target_provider, c.display_name AS connection_name, c.provider, c.publish_mode
                   FROM schedules s
                   JOIN content_drafts d ON d.id = s.draft_id AND d.workspace_id = s.workspace_id
                   JOIN channel_connections c ON c.id = s.connection_id AND c.workspace_id = s.workspace_id`;
  const statement = status
    ? database().prepare(`${fields} WHERE s.workspace_id = ? AND s.status = ? ORDER BY s.created_at DESC LIMIT ?`)
        .bind(TAHA_WORKSPACE_ID, status, limit)
    : database().prepare(`${fields} WHERE s.workspace_id = ? ORDER BY s.created_at DESC LIMIT ?`)
        .bind(TAHA_WORKSPACE_ID, limit);
  const rows = await statement.all<ScheduleRow>();
  return (rows.results ?? []).map(scheduleDto);
}

function nextRunFor(row: ScheduleRow, now: number) {
  if (row.schedule_kind === "once") {
    if (row.run_at == null || row.run_at <= now) {
      throw new ScheduleError("RUN_AT_IN_PAST", "Thời điểm đăng một lần đã qua.", 409);
    }
    if (row.ends_at != null && row.run_at > row.ends_at) {
      throw new ScheduleError("SCHEDULE_ENDED", "Lịch đã vượt thời điểm kết thúc.", 409);
    }
    return row.run_at;
  }
  const nextRunAt = nextScheduledOccurrence({
    scheduleKind: row.schedule_kind,
    localTime: row.local_time,
    weekdays: parseJson<number[]>(row.weekdays_json, []),
    timezone: row.timezone,
    endsAt: row.ends_at,
  }, now);
  if (nextRunAt == null) throw new ScheduleError("SCHEDULE_ENDED", "Lịch không còn lần chạy hợp lệ.", 409);
  return nextRunAt;
}

export async function activateSchedule(idValue: string, now = Date.now()) {
  const id = requiredId(idValue, "Lịch đăng");
  const row = await scheduleRow(id);
  if (!row) throw new ScheduleError("SCHEDULE_NOT_FOUND", "Không tìm thấy lịch trong workspace này.", 404);
  if (row.status === "active") return { schedule: scheduleDto(row), replay: true };
  if (row.status !== "draft" && row.status !== "paused") {
    throw new ScheduleError("SCHEDULE_STATE_CONFLICT", "Lịch ở trạng thái này không thể kích hoạt.", 409);
  }
  const resources = await validateResources(row.draft_id, row.connection_id);
  const executionMode = resources.provider === "zalo_personal" ? "assisted" : row.execution_mode;
  const nextRunAt = nextRunFor(row, now);
  await database().prepare(
    `UPDATE schedules SET status = 'active', next_run_at = ?, execution_mode = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status IN ('draft', 'paused')`,
  ).bind(nextRunAt, executionMode, now, id, TAHA_WORKSPACE_ID).run();
  const activated = await scheduleRow(id);
  if (!activated || activated.status !== "active") {
    throw new ScheduleError("SCHEDULE_STATE_CONFLICT", "Lịch vừa được thay đổi bởi một yêu cầu khác.", 409);
  }
  return { schedule: scheduleDto(activated), replay: false };
}

export async function pauseSchedule(idValue: string, now = Date.now()) {
  const id = requiredId(idValue, "Lịch đăng");
  const row = await scheduleRow(id);
  if (!row) throw new ScheduleError("SCHEDULE_NOT_FOUND", "Không tìm thấy lịch trong workspace này.", 404);
  if (row.status === "paused") return { schedule: scheduleDto(row), replay: true };
  if (row.status !== "active") {
    throw new ScheduleError("SCHEDULE_STATE_CONFLICT", "Chỉ lịch đang hoạt động mới có thể tạm dừng.", 409);
  }
  await database().prepare(
    `UPDATE schedules SET status = 'paused', next_run_at = NULL, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status = 'active'`,
  ).bind(now, id, TAHA_WORKSPACE_ID).run();
  const paused = await scheduleRow(id);
  if (!paused || paused.status !== "paused") {
    throw new ScheduleError("SCHEDULE_STATE_CONFLICT", "Lịch vừa được thay đổi bởi một yêu cầu khác.", 409);
  }
  return { schedule: scheduleDto(paused), replay: false };
}

export function scheduleErrorResponse(error: unknown) {
  if (error instanceof ScheduleError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  return { code: "SCHEDULE_FAILED", message: "Không thể xử lý lịch đăng lúc này.", status: 500 };
}
