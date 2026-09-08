import { getRuntimeEnv } from "./integrations/env";
import { TAHA_WORKSPACE_ID } from "./integrations/store";

export const FACEBOOK_PLAN_TIMEZONE = "Asia/Ho_Chi_Minh" as const;
export const MAX_FACEBOOK_POSTS_PER_DAY = 24;
export const FACEBOOK_PLAN_MIN_LEAD_MS = 30 * 60 * 1_000;
const VN_OFFSET_MS = 7 * 60 * 60 * 1_000;

type Statement = {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
};

type FacebookConnectionRow = {
  id: string;
  config_json: string;
};

export type FacebookPublishingPlan = {
  date: string;
  times: string[];
  updatedAt: number;
};

export class FacebookPublishingPlanError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
    public readonly status = 400,
  ) {
    super(code);
    this.name = "FacebookPublishingPlanError";
  }
}

function database() {
  const value = getRuntimeEnv().DB as unknown as {
    prepare(query: string): Statement;
    batch(statements: Statement[]): Promise<Array<{ meta?: { changes?: number } }>>;
  } | undefined;
  if (!value) throw new FacebookPublishingPlanError("DATABASE_UNAVAILABLE", "Cơ sở dữ liệu lịch đăng chưa sẵn sàng.", 503);
  return value;
}

function objectValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FacebookPublishingPlanError("INVALID_REQUEST", "Dữ liệu lịch Facebook không hợp lệ.", 422);
  }
  return value as Record<string, unknown>;
}

function dateParts(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new FacebookPublishingPlanError("INVALID_DATE", "Ngày đăng phải có định dạng YYYY-MM-DD.", 422);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new FacebookPublishingPlanError("INVALID_DATE", "Ngày đăng không tồn tại.", 422);
  }
  return { value, year, month, day };
}

function normalizeTimes(value: unknown, postCount: number) {
  if (!Array.isArray(value) || value.length !== postCount) {
    throw new FacebookPublishingPlanError(
      "POST_COUNT_MISMATCH",
      "Số khung giờ phải đúng bằng số lượng bài đăng trong ngày.",
      422,
    );
  }
  const times = value.map((item) => {
    if (typeof item !== "string" || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(item)) {
      throw new FacebookPublishingPlanError("INVALID_TIME", "Mỗi giờ đăng phải có định dạng HH:mm.", 422);
    }
    return item;
  });
  if (new Set(times).size !== times.length) {
    throw new FacebookPublishingPlanError("DUPLICATE_TIME", "Các khung giờ trong cùng ngày không được trùng nhau.", 422);
  }
  return times.sort();
}

function parseConfig(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function parseFacebookPublishingPlans(configValue: unknown): FacebookPublishingPlan[] {
  const config = configValue && typeof configValue === "object" && !Array.isArray(configValue)
    ? configValue as Record<string, unknown>
    : {};
  const source = Array.isArray(config.facebookPublishingPlans) ? config.facebookPublishingPlans : [];
  const plans: FacebookPublishingPlan[] = [];
  for (const item of source) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    try {
      const date = dateParts(row.date).value;
      const rawTimes = Array.isArray(row.times) ? row.times : [];
      if (rawTimes.length < 1 || rawTimes.length > MAX_FACEBOOK_POSTS_PER_DAY) continue;
      const times = normalizeTimes(rawTimes, rawTimes.length);
      const updatedAt = Number(row.updatedAt);
      plans.push({ date, times, updatedAt: Number.isSafeInteger(updatedAt) && updatedAt > 0 ? updatedAt : 0 });
    } catch {
      // Ignore malformed legacy configuration without preventing valid plans from running.
    }
  }
  return plans.sort((left, right) => left.date.localeCompare(right.date));
}

export function vietnamTimestamp(date: string, time: string) {
  const parts = dateParts(date);
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
    throw new FacebookPublishingPlanError("INVALID_TIME", "Giờ đăng phải có định dạng HH:mm.", 422);
  }
  const [hour, minute] = time.split(":").map(Number);
  return Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute) - VN_OFFSET_MS;
}

function vietnamDay(now: number) {
  return new Date(now + VN_OFFSET_MS).toISOString().slice(0, 10);
}

async function facebookConnection() {
  const result = await database().prepare(
    `SELECT id, config_json FROM channel_connections
     WHERE workspace_id = ? AND provider = 'facebook' AND status = 'connected' AND publish_mode = 'api'
     ORDER BY updated_at DESC LIMIT 2`,
  ).bind(TAHA_WORKSPACE_ID).all<FacebookConnectionRow>();
  const rows = result.results ?? [];
  if (!rows.length) {
    throw new FacebookPublishingPlanError(
      "FACEBOOK_CONNECTION_REQUIRED",
      "Cần kết nối Facebook Page trước khi cài lịch tự động.",
      409,
    );
  }
  if (rows.length !== 1) {
    throw new FacebookPublishingPlanError(
      "FACEBOOK_CONNECTION_AMBIGUOUS",
      "Có nhiều Facebook Page đang kết nối. Hãy chỉ giữ một Page dùng để đăng tự động.",
      409,
    );
  }
  return rows[0];
}

export async function listFacebookPublishingPlans() {
  const connection = await facebookConnection();
  return {
    connectionId: connection.id,
    timezone: FACEBOOK_PLAN_TIMEZONE,
    plans: parseFacebookPublishingPlans(parseConfig(connection.config_json)),
  };
}

export async function saveFacebookPublishingPlan(value: unknown, now = Date.now()) {
  const body = objectValue(value);
  const date = dateParts(body.date).value;
  const postCount = Number(body.postCount);
  if (!Number.isInteger(postCount) || postCount < 1 || postCount > MAX_FACEBOOK_POSTS_PER_DAY) {
    throw new FacebookPublishingPlanError(
      "INVALID_POST_COUNT",
      `Số lượng bài mỗi ngày phải từ 1 đến ${MAX_FACEBOOK_POSTS_PER_DAY}.`,
      422,
    );
  }
  const times = normalizeTimes(body.times, postCount);
  if (times.some((time) => vietnamTimestamp(date, time) < now + FACEBOOK_PLAN_MIN_LEAD_MS)) {
    throw new FacebookPublishingPlanError(
      "SCHEDULE_LEAD_TIME_REQUIRED",
      "Mỗi khung giờ Facebook cần cách hiện tại ít nhất 30 phút để hệ thống chuẩn bị đúng sản phẩm và hình ảnh.",
      422,
    );
  }

  const connection = await facebookConnection();
  const config = parseConfig(connection.config_json);
  const today = vietnamDay(now);
  const plans = parseFacebookPublishingPlans(config).filter((plan) => plan.date >= today && plan.date !== date);
  const plan = { date, times, updatedAt: now } satisfies FacebookPublishingPlan;
  plans.push(plan);
  plans.sort((left, right) => left.date.localeCompare(right.date));

  const db = database();
  const placeholders = times.map(() => "?").join(",");
  const desiredTimestamps = times.map((time) => vietnamTimestamp(date, time));
  const statements = [
    db.prepare(
    `UPDATE channel_connections
     SET config_json = json_set(CASE WHEN json_valid(config_json) THEN config_json ELSE '{}' END,
       '$.dailyAutomationEnabled', 1,
       '$.facebookPublishingPlans', json(?)), updated_at = ?
     WHERE id = ? AND workspace_id = ? AND provider = 'facebook' AND status = 'connected' AND publish_mode = 'api'`,
    ).bind(JSON.stringify(plans), now, connection.id, TAHA_WORKSPACE_ID),
    db.prepare(
      `UPDATE schedules SET status='paused', next_run_at=NULL, updated_at=?
       WHERE workspace_id=? AND connection_id=? AND status='active' AND run_at>? AND run_at NOT IN (${placeholders})
         AND created_by IN (
           SELECT 'automation:' || id FROM automation_runs
           WHERE workspace_id=? AND request_key LIKE ?
             AND json_extract(content_json, '$.scheduledFor') IS NOT NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM publish_jobs j WHERE j.workspace_id=schedules.workspace_id AND j.schedule_id=schedules.id
             AND j.status IN ('publishing','published','uncertain')
         )`,
    ).bind(now, TAHA_WORKSPACE_ID, connection.id, now, ...desiredTimestamps, TAHA_WORKSPACE_ID, `daily:${date}:%`),
    db.prepare(
      `UPDATE automation_steps SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL,
         completed_at=?, updated_at=?
       WHERE workspace_id=? AND status IN ('queued','processing','retry_wait') AND run_id IN (
         SELECT id FROM automation_runs WHERE workspace_id=? AND request_key LIKE ?
           AND status IN ('queued','processing')
           AND json_extract(content_json, '$.scheduledFor') IS NOT NULL
           AND json_extract(content_json, '$.scheduledFor') NOT IN (${placeholders})
       )`,
    ).bind(now, now, TAHA_WORKSPACE_ID, TAHA_WORKSPACE_ID, `daily:${date}:%`, ...desiredTimestamps),
    db.prepare(
      `UPDATE automation_runs SET status='cancelled', completed_at=?, updated_at=?
       WHERE workspace_id=? AND request_key LIKE ? AND status IN ('queued','processing')
         AND json_extract(content_json, '$.scheduledFor') IS NOT NULL
         AND json_extract(content_json, '$.scheduledFor') NOT IN (${placeholders})`,
    ).bind(now, now, TAHA_WORKSPACE_ID, `daily:${date}:%`, ...desiredTimestamps),
  ];
  const results = await db.batch(statements);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    throw new FacebookPublishingPlanError("FACEBOOK_PLAN_SAVE_CONFLICT", "Kết nối Facebook vừa thay đổi. Hãy tải lại và lưu lần nữa.", 409);
  }
  return {
    connectionId: connection.id,
    timezone: FACEBOOK_PLAN_TIMEZONE,
    plan,
    plans,
    reconciledSchedules: Number(results[1]?.meta?.changes ?? 0),
    reconciledRuns: Number(results[3]?.meta?.changes ?? 0),
  };
}
