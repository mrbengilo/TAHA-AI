import { getRuntimeEnv } from "./integrations/env";
import { TAHA_WORKSPACE_ID } from "./integrations/store";

type UpcomingRow = {
  scheduled_for: number;
  status: string;
  provider: string;
  title: string | null;
  body: string | null;
};

type ReviewRow = {
  id: string;
  target_provider: string;
  title: string | null;
  body: string;
  product_name: string;
};

export type DashboardSnapshot = {
  publishedThisMonth: number;
  generatedImages: number;
  activeProducts: number;
  attentionCount: number;
  reviewCount: number;
  connectedProviders: string[];
  upcoming: UpcomingRow[];
  review: ReviewRow | null;
};

const emptySnapshot: DashboardSnapshot = {
  publishedThisMonth: 0,
  generatedImages: 0,
  activeProducts: 0,
  attentionCount: 0,
  reviewCount: 0,
  connectedProviders: [],
  upcoming: [],
  review: null,
};

async function count(database: D1Database, sql: string, ...values: unknown[]) {
  const row = await database.prepare(sql).bind(...values).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const database = getRuntimeEnv().DB;
  if (!database) return emptySnapshot;
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  try {
    const [publishedThisMonth, generatedImages, activeProducts, failedJobs, connectionErrors, reviewCount, connections, upcoming, review] = await Promise.all([
      count(database, "SELECT COUNT(*) AS total FROM publish_jobs WHERE workspace_id = ? AND status = 'published' AND completed_at >= ?", TAHA_WORKSPACE_ID, monthStart),
      count(database, "SELECT COUNT(*) AS total FROM media_assets WHERE workspace_id = ? AND origin = 'generated' AND status = 'ready'", TAHA_WORKSPACE_ID),
      count(database, "SELECT COUNT(*) AS total FROM products WHERE workspace_id = ? AND status = 'active' AND deleted_at IS NULL", TAHA_WORKSPACE_ID),
      count(database, "SELECT COUNT(*) AS total FROM publish_jobs WHERE workspace_id = ? AND status IN ('failed', 'blocked')", TAHA_WORKSPACE_ID),
      count(database, "SELECT COUNT(*) AS total FROM channel_connections WHERE workspace_id = ? AND status IN ('expired', 'revoked', 'error')", TAHA_WORKSPACE_ID),
      count(database, "SELECT COUNT(*) AS total FROM content_drafts WHERE workspace_id = ? AND status = 'in_review'", TAHA_WORKSPACE_ID),
      database.prepare("SELECT DISTINCT provider FROM channel_connections WHERE workspace_id = ? AND status = 'connected'").bind(TAHA_WORKSPACE_ID).all<{ provider: string }>(),
      database.prepare(
        `SELECT j.scheduled_for, j.status, c.provider, d.title, d.body
         FROM publish_jobs j
         JOIN channel_connections c ON c.id = j.connection_id
         LEFT JOIN content_drafts d ON d.id = j.draft_id
         WHERE j.workspace_id = ? AND j.status IN ('queued', 'awaiting_confirmation', 'retry_wait')
         ORDER BY j.scheduled_for ASC LIMIT 3`,
      ).bind(TAHA_WORKSPACE_ID).all<UpcomingRow>(),
      database.prepare(
        `SELECT d.id, d.target_provider, d.title, d.body, p.name AS product_name
         FROM content_drafts d JOIN products p ON p.id = d.product_id
         WHERE d.workspace_id = ? AND d.status = 'in_review'
         ORDER BY d.updated_at ASC LIMIT 1`,
      ).bind(TAHA_WORKSPACE_ID).first<ReviewRow>(),
    ]);
    return {
      publishedThisMonth,
      generatedImages,
      activeProducts,
      attentionCount: failedJobs + connectionErrors,
      reviewCount,
      connectedProviders: (connections.results ?? []).map((row) => row.provider),
      upcoming: upcoming.results ?? [],
      review: review ?? null,
    };
  } catch {
    return emptySnapshot;
  }
}
