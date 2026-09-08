import { getRuntimeEnv } from "./integrations/env";
import { TAHA_WORKSPACE_ID } from "./integrations/store";
import { runPublishDispatcher, type DispatcherDatabase, type DispatcherPublishers } from "./dispatcher";
import { runSchedulerTick, type SchedulerDatabase } from "./scheduler";

type DeliveryDatabase = DispatcherDatabase & SchedulerDatabase;
type DeliveryOptions = { database?: DeliveryDatabase; publishers?: DispatcherPublishers; now?: number };
type Run = {
  id: string; product_id: string; status: string; requested_image_count: number; completed_image_count: number;
  target_providers_json: string; connection_id: string | null; prepare_only: number | null;
};
type Schedule = {
  id: string; draft_id: string; connection_id: string; status: string; schedule_kind: string;
  execution_mode: string; provider: string; publish_mode: string; connection_status: string;
  product_id: string; target_provider: string; draft_status: string; archived_at: number | null;
  automation_run_id: string | null;
};
type Job = {
  id: string; status: string; schedule_id: string; connection_id: string; product_id: string; draft_id: string;
  job_kind: string; attempt_count: number; external_post_id: string | null; external_url: string | null;
};

export class WebsiteDeliveryError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}

function requireState(condition: unknown, code: string): asserts condition {
  if (!condition) throw new WebsiteDeliveryError(code);
}

function checkJobs(jobs: Job[], run: Run, schedule: Schedule) {
  requireState(jobs.length <= 1, "WEBSITE_DELIVERY_JOB_AMBIGUOUS");
  for (const job of jobs) {
    requireState(job.schedule_id === schedule.id && job.connection_id === run.connection_id
      && job.product_id === run.product_id && job.draft_id === schedule.draft_id && job.job_kind === "listing_upsert",
    "WEBSITE_DELIVERY_JOB_MISMATCH");
    if (job.status === "published") {
      // The channel adapter validates its own receipt schema/URL. Keep this
      // endpoint generic while refusing empty or partial persisted receipts.
      requireState(typeof job.external_post_id === "string" && job.external_post_id.trim().length > 0
        && typeof job.external_url === "string" && job.external_url.trim().length > 0,
      "WEBSITE_DELIVERY_RECEIPT_INVALID");
    } else {
      requireState(job.status === "queued" && job.attempt_count === 0 && !job.external_post_id && !job.external_url,
        "WEBSITE_DELIVERY_OUTCOME_REQUIRES_REVIEW");
    }
  }
}

/** Deliver one completed, website-only, source-image automation through the normal scheduler/dispatcher. */
export async function deliverWebsiteAutomationRun(runId: string, options: DeliveryOptions = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId)) {
    throw new WebsiteDeliveryError("WEBSITE_DELIVERY_RUN_INVALID", 400);
  }
  const database = options.database ?? getRuntimeEnv().DB as unknown as DeliveryDatabase | undefined;
  if (!database) throw new WebsiteDeliveryError("DATABASE_UNAVAILABLE", 503);
  const now = options.now ?? Date.now();
  const run = await database.prepare(`SELECT r.id,r.product_id,r.status,r.requested_image_count,r.completed_image_count,
    r.target_providers_json,json_extract(r.content_json,'$.targetConnections.website') AS connection_id,
    json_extract(r.content_json,'$.prepareOnly') AS prepare_only
    FROM automation_runs r JOIN products p ON p.id=r.product_id AND p.workspace_id=r.workspace_id
    WHERE r.id=? AND r.workspace_id=? AND p.status='active' AND p.deleted_at IS NULL`)
    .bind(runId, TAHA_WORKSPACE_ID).first<Run>();
  requireState(run, "WEBSITE_DELIVERY_RUN_NOT_FOUND");
  let providers: unknown;
  try { providers = JSON.parse(run.target_providers_json); } catch { providers = null; }
  requireState(run.status === "completed" && run.requested_image_count === 0 && run.completed_image_count === 0
    && run.prepare_only === 0 && Array.isArray(providers) && providers.length === 1 && providers[0] === "website"
    && typeof run.connection_id === "string" && run.connection_id.length > 0, "WEBSITE_DELIVERY_RUN_NOT_ELIGIBLE");
  const schedules = await database.prepare(`SELECT s.id,s.draft_id,s.connection_id,s.status,s.schedule_kind,s.execution_mode,
    c.provider,c.publish_mode,c.status AS connection_status,d.product_id,d.target_provider,d.status AS draft_status,d.archived_at,
    json_extract(d.platform_data_json,'$.automationRunId') AS automation_run_id
    FROM schedules s
    LEFT JOIN content_drafts d ON d.id=s.draft_id AND d.workspace_id=s.workspace_id
    LEFT JOIN channel_connections c ON c.id=s.connection_id AND c.workspace_id=s.workspace_id
    WHERE s.workspace_id=? AND s.created_by=?`)
    .bind(TAHA_WORKSPACE_ID, `automation:${runId}`).all<Schedule>();
  requireState(schedules.results?.length === 1, "WEBSITE_DELIVERY_SCHEDULE_AMBIGUOUS");
  const schedule = schedules.results[0];
  requireState(schedule.connection_id === run.connection_id && schedule.provider === "website"
    && schedule.publish_mode === "api" && schedule.connection_status === "connected"
    && schedule.product_id === run.product_id && schedule.target_provider === "website"
    && schedule.draft_status === "approved" && schedule.archived_at === null && schedule.automation_run_id === runId
    && schedule.schedule_kind === "once" && ["auto", "inherit"].includes(schedule.execution_mode)
    && ["active", "completed"].includes(schedule.status), "WEBSITE_DELIVERY_SCHEDULE_MISMATCH");
  const readJobs = async () => (await database.prepare(`SELECT id,status,schedule_id,connection_id,product_id,draft_id,
    job_kind,attempt_count,external_post_id,external_url FROM publish_jobs
    WHERE workspace_id=? AND (schedule_id=? OR draft_id=?)`)
    .bind(TAHA_WORKSPACE_ID, schedule.id, schedule.draft_id).all<Job>()).results ?? [];
  let jobs = await readJobs();
  checkJobs(jobs, run, schedule);
  if (jobs[0]?.status === "published") return { runId, job: jobs[0], replayed: true };
  const scheduler = await runSchedulerTick({ database, now, limit: 1, scheduleIds: [schedule.id] });
  requireState(scheduler.failed === 0, "WEBSITE_DELIVERY_SCHEDULER_FAILED");
  jobs = await readJobs();
  checkJobs(jobs, run, schedule);
  requireState(jobs.length === 1, "WEBSITE_DELIVERY_NOT_DUE");
  if (jobs[0].status === "published") return { runId, job: jobs[0], replayed: true };
  const dispatcher = await runPublishDispatcher({ database, publishers: options.publishers, now, limit: 1, jobIds: [jobs[0].id] });
  const finalJobs = await readJobs();
  requireState(finalJobs.length === 1 && finalJobs[0].id === jobs[0].id, "WEBSITE_DELIVERY_RESULT_AMBIGUOUS");
  checkJobs(finalJobs, run, schedule);
  requireState(finalJobs[0].status === "published", "WEBSITE_DELIVERY_NOT_CONFIRMED");
  return { runId, job: finalJobs[0], replayed: false, scheduler, dispatcher };
}
