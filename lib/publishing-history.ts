import { parseFacebookPublishingPlans, vietnamTimestamp } from "./facebook-publishing-plans";
import { getRuntimeEnv } from "./integrations/env";
import { TAHA_WORKSPACE_ID } from "./integrations/store";

export const PUBLISHING_PROVIDERS = [
  "facebook",
  "website",
  "zalo_personal",
  "shopee",
  "tiktok_shop",
] as const;

export type PublishingProvider = (typeof PUBLISHING_PROVIDERS)[number];

export type PublishingCalendarEntry = {
  id: string;
  provider: PublishingProvider;
  productId: string | null;
  sku: string | null;
  productName: string | null;
  title: string | null;
  scheduledFor: number;
  status: string;
  errorMessage: string | null;
  requestKey: string | null;
  source: "plan" | "automation" | "schedule";
};

export type PublishingActivityEntry = {
  id: string;
  provider: PublishingProvider;
  productId: string | null;
  sku: string | null;
  productName: string | null;
  title: string | null;
  status: string;
  scheduledFor: number;
  completedAt: number | null;
  updatedAt: number;
  errorMessage: string | null;
  externalUrl: string | null;
};

type ScheduleRow = {
  id: string;
  provider: string;
  product_id: string | null;
  base_sku: string | null;
  product_name: string | null;
  title: string | null;
  scheduled_for: number;
  schedule_status: string;
  job_status: string | null;
  error_message: string | null;
  request_key: string | null;
  automation_run_id: string | null;
};

type AutomationRow = {
  id: string;
  product_id: string;
  base_sku: string;
  product_name: string;
  scheduled_for: number;
  status: string;
  error_message: string | null;
  request_key: string;
};

type ActivityRow = {
  id: string;
  provider: string;
  product_id: string | null;
  base_sku: string | null;
  product_name: string | null;
  title: string | null;
  status: string;
  scheduled_for: number;
  completed_at: number | null;
  updated_at: number;
  error_message: string | null;
  external_url: string | null;
};

type FacebookConfigRow = { config_json: string };

function isPublishingProvider(value: string): value is PublishingProvider {
  return (PUBLISHING_PROVIDERS as readonly string[]).includes(value);
}

function vietnamDay(now: number) {
  return new Date(now + 7 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

function scheduleStatus(row: ScheduleRow) {
  if (row.job_status) return row.job_status;
  if (row.schedule_status === "completed") return "completed";
  return "scheduled";
}

function isDailyPlanRequest(requestKey: string | null, date: string, time: string) {
  if (!requestKey) return false;
  return requestKey.startsWith(`daily:${date}:${time.replace(":", "")}:`)
    || (time === "08:00" && requestKey.startsWith(`daily:${date}:`) && requestKey.split(":").length === 3);
}

/**
 * Returns every concrete upcoming publication used by the calendar page.
 * Automation runs are included before their draft/schedule is finalized, so an
 * admin can see the selected product immediately instead of waiting for cron.
 */
export async function listPublishingCalendar(now = Date.now()): Promise<PublishingCalendarEntry[]> {
  const database = getRuntimeEnv().DB;
  if (!database) return [];
  try {
  const today = vietnamDay(now);
  const todayStart = vietnamTimestamp(today, "00:00");

  const [scheduleResult, automationResult, facebookConfig] = await Promise.all([
    database.prepare(
      `SELECT s.id, c.provider,
          COALESCE(j.product_id, d.product_id) AS product_id,
          p.base_sku, p.name AS product_name, d.title,
          COALESCE(j.scheduled_for, s.run_at, s.next_run_at) AS scheduled_for,
          s.status AS schedule_status, j.status AS job_status, j.error_message,
          ar.request_key, ar.id AS automation_run_id
       FROM schedules s
       JOIN channel_connections c ON c.id = s.connection_id AND c.workspace_id = s.workspace_id
       JOIN content_drafts d ON d.id = s.draft_id AND d.workspace_id = s.workspace_id
       LEFT JOIN automation_runs ar
         ON s.created_by = 'automation:' || ar.id AND ar.workspace_id = s.workspace_id
       LEFT JOIN publish_jobs j ON j.id = (
         SELECT candidate.id FROM publish_jobs candidate
         WHERE candidate.workspace_id = s.workspace_id AND candidate.schedule_id = s.id
         ORDER BY candidate.created_at DESC LIMIT 1
       )
       LEFT JOIN products p
         ON p.id = COALESCE(j.product_id, d.product_id) AND p.workspace_id = s.workspace_id
       WHERE s.workspace_id = ? AND s.status IN ('active', 'completed')
         AND COALESCE(j.scheduled_for, s.run_at, s.next_run_at) >= ?
         AND c.provider IN ('facebook','website','zalo_personal','shopee','tiktok_shop')
       ORDER BY scheduled_for ASC, s.created_at ASC`,
    ).bind(TAHA_WORKSPACE_ID, todayStart).all<ScheduleRow>(),
    database.prepare(
      `SELECT r.id, r.product_id, p.base_sku, p.name AS product_name,
          CAST(json_extract(r.content_json, '$.scheduledFor') AS INTEGER) AS scheduled_for,
          r.status, r.error_message, r.request_key
       FROM automation_runs r
       JOIN products p ON p.id = r.product_id AND p.workspace_id = r.workspace_id
       WHERE r.workspace_id = ? AND r.status IN ('queued','processing','completed','failed')
         AND CAST(json_extract(r.content_json, '$.scheduledFor') AS INTEGER) >= ?
         AND EXISTS (
           SELECT 1 FROM json_each(r.target_providers_json) provider
           WHERE provider.value = 'facebook'
         )
       ORDER BY scheduled_for ASC, r.created_at ASC`,
    ).bind(TAHA_WORKSPACE_ID, todayStart).all<AutomationRow>(),
    database.prepare(
      `SELECT config_json FROM channel_connections
       WHERE workspace_id = ? AND provider = 'facebook' AND status = 'connected'
         AND publish_mode = 'api'
       ORDER BY updated_at DESC LIMIT 1`,
    ).bind(TAHA_WORKSPACE_ID).first<FacebookConfigRow>(),
  ]);

  const entries: PublishingCalendarEntry[] = [];
  const scheduledRunIds = new Set<string>();
  for (const row of scheduleResult.results ?? []) {
    if (!isPublishingProvider(row.provider) || !Number.isFinite(row.scheduled_for)) continue;
    if (row.automation_run_id) scheduledRunIds.add(row.automation_run_id);
    entries.push({
      id: row.id,
      provider: row.provider,
      productId: row.product_id,
      sku: row.base_sku,
      productName: row.product_name,
      title: row.title,
      scheduledFor: Number(row.scheduled_for),
      status: scheduleStatus(row),
      errorMessage: row.error_message,
      requestKey: row.request_key,
      source: "schedule",
    });
  }

  for (const row of automationResult.results ?? []) {
    if (scheduledRunIds.has(row.id) || !Number.isFinite(row.scheduled_for)) continue;
    entries.push({
      id: row.id,
      provider: "facebook",
      productId: row.product_id,
      sku: row.base_sku,
      productName: row.product_name,
      title: null,
      scheduledFor: Number(row.scheduled_for),
      status: row.status === "failed" ? "preparation_failed" : "preparing",
      errorMessage: row.error_message,
      requestKey: row.request_key,
      source: "automation",
    });
  }

  let config: Record<string, unknown> = {};
  try { config = JSON.parse(facebookConfig?.config_json ?? "{}") as Record<string, unknown>; } catch { /* malformed config has no visible plans */ }
  for (const plan of parseFacebookPublishingPlans(config)) {
    for (const time of plan.times) {
      const scheduledFor = vietnamTimestamp(plan.date, time);
      if (scheduledFor < todayStart) continue;
      const hasConcreteEntry = entries.some((entry) => entry.provider === "facebook"
        && entry.scheduledFor === scheduledFor
        && isDailyPlanRequest(entry.requestKey, plan.date, time));
      if (hasConcreteEntry) continue;
      entries.push({
        id: `facebook-plan:${plan.date}:${time}`,
        provider: "facebook",
        productId: null,
        sku: null,
        productName: null,
        title: null,
        scheduledFor,
        status: "awaiting_assignment",
        errorMessage: null,
        requestKey: null,
        source: "plan",
      });
    }
  }

  return entries.sort((left, right) => left.scheduledFor - right.scheduledFor || left.id.localeCompare(right.id));
  } catch {
    // Keep the operator UI available while a fresh local/production database is still migrating.
    return [];
  }
}

/** Returns the complete persisted publish-job history for the five output channels. */
export async function listPublishingActivity(): Promise<PublishingActivityEntry[]> {
  const database = getRuntimeEnv().DB;
  if (!database) return [];
  try {
  const result = await database.prepare(
    `SELECT j.id, c.provider,
        COALESCE(j.product_id, d.product_id) AS product_id,
        p.base_sku, p.name AS product_name, d.title, j.status,
        j.scheduled_for, j.completed_at, j.updated_at, j.error_message, j.external_url
     FROM publish_jobs j
     JOIN channel_connections c ON c.id = j.connection_id AND c.workspace_id = j.workspace_id
     LEFT JOIN content_drafts d ON d.id = j.draft_id AND d.workspace_id = j.workspace_id
     LEFT JOIN products p
       ON p.id = COALESCE(j.product_id, d.product_id) AND p.workspace_id = j.workspace_id
     WHERE j.workspace_id = ?
       AND c.provider IN ('facebook','website','zalo_personal','shopee','tiktok_shop')
     ORDER BY COALESCE(j.completed_at, j.scheduled_for, j.updated_at) DESC, j.created_at DESC`,
  ).bind(TAHA_WORKSPACE_ID).all<ActivityRow>();

  return (result.results ?? []).flatMap((row) => isPublishingProvider(row.provider) ? [{
    id: row.id,
    provider: row.provider,
    productId: row.product_id,
    sku: row.base_sku,
    productName: row.product_name,
    title: row.title,
    status: row.status,
    scheduledFor: Number(row.scheduled_for),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    updatedAt: Number(row.updated_at),
    errorMessage: row.error_message,
    externalUrl: row.external_url,
  }] : []);
  } catch {
    // Match the dashboard's safe empty state if the publish tables are not ready yet.
    return [];
  }
}
