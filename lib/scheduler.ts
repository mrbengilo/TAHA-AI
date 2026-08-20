import { getRuntimeEnv } from "./integrations/env";

export const TAHA_SCHEDULER_TIMEZONE = "Asia/Ho_Chi_Minh";

const HO_CHI_MINH_OFFSET_MS = 7 * 60 * 60 * 1_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type ScheduleKind = "once" | "daily" | "weekly";
type ExecutionMode = "inherit" | "auto" | "assisted";
type JobStatus = "queued" | "awaiting_confirmation" | "blocked";

type ScheduleRow = {
  id: string;
  workspace_id: string;
  draft_id: string;
  connection_id: string;
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
  product_id: string | null;
  content_type: string;
  title: string | null;
  body: string;
  hashtags_json: string | null;
  platform_data_json: string | null;
  provider: string;
  publish_mode: string;
  connection_status: string;
};

export type RecurrenceInput = {
  scheduleKind: ScheduleKind;
  localTime: string | null;
  weekdays: number[];
  timezone: string;
  endsAt?: number | null;
};

export type SchedulerTickResult = {
  checked: number;
  enqueued: number;
  replayed: number;
  initialized: number;
  completed: number;
  failed: number;
  errors: Array<{ scheduleId: string; code: string }>;
  tickedAt: number;
};

type SchedulerD1Result = {
  meta?: { changes?: number };
};

type SchedulerStatement = {
  bind(...values: unknown[]): SchedulerStatement;
  run(): Promise<SchedulerD1Result>;
  all<T>(): Promise<{ results?: T[] }>;
};

export type SchedulerDatabase = {
  prepare(query: string): SchedulerStatement;
  batch(statements: SchedulerStatement[]): Promise<SchedulerD1Result[]>;
};

export type SchedulerTickOptions = {
  database?: SchedulerDatabase;
  now?: number;
  limit?: number;
};

function schedulerDatabase(override?: SchedulerDatabase) {
  const database = override ?? (getRuntimeEnv().DB as unknown as SchedulerDatabase | undefined);
  if (!database) throw new Error("DATABASE_UNAVAILABLE");
  return database;
}

function parseLocalTime(value: string | null) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? "");
  if (!match) throw new Error("INVALID_LOCAL_TIME");
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function assertTimezone(timezone: string) {
  if (timezone !== TAHA_SCHEDULER_TIMEZONE) {
    throw new Error("UNSUPPORTED_TIMEZONE");
  }
}

function normalizeWeekdays(values: number[]) {
  const normalized = new Set<number>();
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0 || value > 7) continue;
    normalized.add(value === 7 ? 0 : value);
  }
  return normalized;
}

function localDateAt(epochMs: number) {
  const local = new Date(epochMs + HO_CHI_MINH_OFFSET_MS);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth(),
    date: local.getUTCDate(),
  };
}

function localCandidate(
  base: ReturnType<typeof localDateAt>,
  dayOffset: number,
  hour: number,
  minute: number,
) {
  const localDay = new Date(Date.UTC(base.year, base.month, base.date + dayOffset));
  const epochMs = Date.UTC(
    localDay.getUTCFullYear(),
    localDay.getUTCMonth(),
    localDay.getUTCDate(),
    hour,
    minute,
  ) - HO_CHI_MINH_OFFSET_MS;
  return { epochMs, weekday: localDay.getUTCDay() };
}

/**
 * Returns the first recurrence strictly after `afterMs`.
 * Weekdays accept Monday=1 through Saturday=6 and Sunday as either 0 or 7.
 */
export function nextScheduledOccurrence(input: RecurrenceInput, afterMs: number) {
  if (input.scheduleKind === "once") return null;
  assertTimezone(input.timezone);
  const { hour, minute } = parseLocalTime(input.localTime);
  const base = localDateAt(afterMs);
  const weekdays = normalizeWeekdays(input.weekdays);
  if (input.scheduleKind === "weekly" && weekdays.size === 0) {
    throw new Error("INVALID_WEEKDAYS");
  }

  const searchDays = input.scheduleKind === "daily" ? 2 : 8;
  for (let dayOffset = 0; dayOffset <= searchDays; dayOffset += 1) {
    const candidate = localCandidate(base, dayOffset, hour, minute);
    if (candidate.epochMs <= afterMs) continue;
    if (input.scheduleKind === "weekly" && !weekdays.has(candidate.weekday)) continue;
    if (input.endsAt != null && candidate.epochMs > input.endsAt) return null;
    return candidate.epochMs;
  }

  return null;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function recurrenceFor(row: ScheduleRow): RecurrenceInput {
  return {
    scheduleKind: row.schedule_kind,
    localTime: row.local_time,
    weekdays: parseJson<number[]>(row.weekdays_json, []),
    timezone: row.timezone,
    endsAt: row.ends_at,
  };
}

function dueAt(row: ScheduleRow) {
  if (typeof row.next_run_at === "number") return row.next_run_at;
  if (row.schedule_kind === "once" && typeof row.run_at === "number") return row.run_at;
  return null;
}

function nextStatus(row: ScheduleRow): JobStatus {
  if (row.connection_status !== "connected") return "blocked";
  if (
    row.provider === "zalo_personal" ||
    row.execution_mode === "assisted" ||
    (row.execution_mode === "inherit" && row.publish_mode === "assisted")
  ) {
    return "awaiting_confirmation";
  }
  return "queued";
}

function jobKind(contentType: string) {
  return contentType === "product_listing" ? "listing_upsert" : "social_post";
}

function resultChanges(result: SchedulerD1Result | undefined) {
  return Number(result?.meta?.changes ?? 0);
}

async function initializeSchedule(database: SchedulerDatabase, row: ScheduleRow, now: number) {
  let nextRunAt: number | null;
  if (row.schedule_kind === "once") {
    nextRunAt = row.run_at;
  } else {
    nextRunAt = nextScheduledOccurrence(recurrenceFor(row), now - 1);
  }

  if (nextRunAt == null || (row.ends_at != null && nextRunAt > row.ends_at)) {
    const result = await database.prepare(
      `UPDATE schedules SET status = 'completed', next_run_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'active' AND next_run_at IS NULL`,
    ).bind(now, row.id).run();
    return { initialized: false, completed: resultChanges(result) > 0 };
  }

  const result = await database.prepare(
    `UPDATE schedules SET next_run_at = ?, updated_at = ?
     WHERE id = ? AND status = 'active' AND next_run_at IS NULL`,
  ).bind(nextRunAt, now, row.id).run();
  return { initialized: resultChanges(result) > 0, completed: false };
}

async function mediaIdsFor(database: SchedulerDatabase, draftId: string) {
  const result = await database.prepare(
    `SELECT media_id FROM content_draft_media
     WHERE draft_id = ? ORDER BY sort_order ASC, created_at ASC`,
  ).bind(draftId).all<{ media_id: string }>();
  return (result.results ?? []).map((item) => item.media_id);
}

async function enqueueOccurrence(
  database: SchedulerDatabase,
  row: ScheduleRow,
  occurrenceAt: number,
  now: number,
) {
  const mediaIds = await mediaIdsFor(database, row.draft_id);
  const status = nextStatus(row);
  const nextRunAt = row.schedule_kind === "once"
    ? null
    : nextScheduledOccurrence(recurrenceFor(row), Math.max(now, occurrenceAt));
  const scheduleStatus = row.schedule_kind === "once" || nextRunAt == null
    ? "completed"
    : "active";
  const dedupeKey = `schedule:${row.id}:${occurrenceAt}`;
  const payload = {
    scheduleId: row.id,
    provider: row.provider,
    contentType: row.content_type,
    title: row.title,
    message: row.body,
    hashtags: parseJson<string[]>(row.hashtags_json, []),
    platformData: parseJson<Record<string, unknown>>(row.platform_data_json, {}),
    mediaIds,
    publishOptions: parseJson<Record<string, unknown>>(row.publish_options_json, {}),
    requiresHumanConfirmation: status === "awaiting_confirmation",
    occurrenceAt,
  };

  const insert = database.prepare(
    `INSERT INTO publish_jobs
     (id, workspace_id, schedule_id, connection_id, product_id, draft_id, job_kind, dedupe_key,
      status, scheduled_for, available_at, payload_snapshot_json, attempt_count, max_attempts,
      provider_response_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 5, '{}', ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
  ).bind(
    crypto.randomUUID(),
    row.workspace_id,
    row.id,
    row.connection_id,
    row.product_id,
    row.draft_id,
    jobKind(row.content_type),
    dedupeKey,
    status,
    occurrenceAt,
    occurrenceAt,
    JSON.stringify(payload),
    now,
    now,
  );

  const updateSql = row.next_run_at == null
    ? `UPDATE schedules SET status = ?, next_run_at = ?, last_run_at = ?, updated_at = ?
       WHERE id = ? AND status = 'active' AND next_run_at IS NULL AND run_at = ?`
    : `UPDATE schedules SET status = ?, next_run_at = ?, last_run_at = ?, updated_at = ?
       WHERE id = ? AND status = 'active' AND next_run_at = ?`;
  const update = database.prepare(updateSql).bind(
    scheduleStatus,
    nextRunAt,
    occurrenceAt,
    now,
    row.id,
    occurrenceAt,
  );

  const results = await database.batch([insert, update]);
  return {
    inserted: resultChanges(results[0]) > 0,
    advanced: resultChanges(results[1]) > 0,
    completed: scheduleStatus === "completed" && resultChanges(results[1]) > 0,
  };
}

export async function runSchedulerTick(options: SchedulerTickOptions = {}): Promise<SchedulerTickResult> {
  const database = schedulerDatabase(options.database);
  const now = Math.floor(options.now ?? Date.now());
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  const due = await database.prepare(
    `SELECT s.id, s.workspace_id, s.draft_id, s.connection_id, s.schedule_kind, s.run_at,
            s.local_time, s.weekdays_json, s.timezone, s.next_run_at, s.last_run_at, s.ends_at,
            s.execution_mode, s.publish_options_json, d.product_id, d.content_type, d.title, d.body,
            d.hashtags_json, d.platform_data_json, c.provider, c.publish_mode,
            c.status AS connection_status
     FROM schedules s
     JOIN content_drafts d ON d.id = s.draft_id AND d.workspace_id = s.workspace_id
     JOIN channel_connections c ON c.id = s.connection_id AND c.workspace_id = s.workspace_id
     WHERE s.status = 'active' AND (s.next_run_at IS NULL OR s.next_run_at <= ?)
     ORDER BY CASE WHEN s.next_run_at IS NULL THEN 1 ELSE 0 END, s.next_run_at ASC, s.created_at ASC
     LIMIT ?`,
  ).bind(now, limit).all<ScheduleRow>();

  const result: SchedulerTickResult = {
    checked: 0,
    enqueued: 0,
    replayed: 0,
    initialized: 0,
    completed: 0,
    failed: 0,
    errors: [],
    tickedAt: now,
  };

  for (const row of due.results ?? []) {
    result.checked += 1;
    try {
      const occurrenceAt = dueAt(row);
      if (occurrenceAt == null || occurrenceAt > now) {
        const initialized = await initializeSchedule(database, row, now);
        if (initialized.initialized) result.initialized += 1;
        if (initialized.completed) result.completed += 1;
        continue;
      }
      if (row.ends_at != null && occurrenceAt > row.ends_at) {
        const completed = await database.prepare(
          `UPDATE schedules SET status = 'completed', next_run_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'active'`,
        ).bind(now, row.id).run();
        if (resultChanges(completed) > 0) result.completed += 1;
        continue;
      }

      const enqueued = await enqueueOccurrence(database, row, occurrenceAt, now);
      if (enqueued.inserted) result.enqueued += 1;
      else result.replayed += 1;
      if (enqueued.completed) result.completed += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push({
        scheduleId: row.id,
        code: error instanceof Error ? error.message : "SCHEDULER_FAILED",
      });
    }
  }

  return result;
}
