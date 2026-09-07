import { getRuntimeEnv } from "./integrations/env";
import { TAHA_WORKSPACE_ID } from "./integrations/store";
import { objectJson, productSources } from "./product-integrity";

export async function getProductFolder(id: string) {
  const db = getRuntimeEnv().DB;
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  const product = await db.prepare(`SELECT id, base_sku, name, description, status, metadata_json FROM products
    WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`).bind(id, TAHA_WORKSPACE_ID)
    .first<{ id: string; base_sku: string; name: string; description: string; status: string; metadata_json: string }>();
  if (!product) throw new Error("PRODUCT_NOT_FOUND");
  let validationError: string | null = null;
  let images: Array<{ id: string; filename: string; previewUrl: string }> = [];
  try {
    const sources = await productSources(id);
    images = sources.images.map((image) => ({ id: image.id, filename: String(objectJson(image.metadata_json).name || image.external_id), previewUrl: `/api/media/${encodeURIComponent(image.id)}/download?inline=1` }));
  } catch (error) { validationError = error instanceof Error ? error.message : "PRODUCT_VALIDATION_FAILED"; }
  const [draftRows, scheduleRows, jobRows, runRows] = await Promise.all([
    db.prepare(`SELECT id, target_provider, title, body, hashtags_json, status, version, platform_data_json FROM content_drafts
      WHERE product_id = ? AND workspace_id = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 100`).bind(id, TAHA_WORKSPACE_ID)
      .all<{ id: string; target_provider: string; title: string; body: string; hashtags_json: string; status: string; version: number; platform_data_json: string }>(),
    db.prepare(`SELECT s.id, s.draft_id, s.status, s.run_at, s.next_run_at, c.display_name AS destination FROM schedules s
      JOIN content_drafts d ON d.id = s.draft_id AND d.workspace_id = s.workspace_id JOIN channel_connections c ON c.id = s.connection_id
      WHERE d.product_id = ? AND s.workspace_id = ? ORDER BY s.created_at DESC LIMIT 100`).bind(id, TAHA_WORKSPACE_ID)
      .all<{ id: string; draft_id: string; status: string; run_at: number; next_run_at: number | null; destination: string }>(),
    db.prepare(`SELECT id, draft_id, status, external_url, error_code, error_message FROM publish_jobs WHERE product_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 100`).bind(id, TAHA_WORKSPACE_ID)
      .all<{ id: string; draft_id: string; status: string; external_url: string | null; error_code: string | null; error_message: string | null }>(),
    db.prepare(`SELECT id, status, error_code, error_message FROM automation_runs WHERE product_id = ? AND workspace_id = ? AND requested_image_count = 0 ORDER BY created_at DESC LIMIT 10`).bind(id, TAHA_WORKSPACE_ID)
      .all<{ id: string; status: string; error_code: string | null; error_message: string | null }>(),
  ]);
  const drafts = draftRows.results.map((draft) => ({ ...draft, hashtags: JSON.parse(draft.hashtags_json) as string[], productDescription: String(objectJson(draft.platform_data_json).productDescription || "") }));
  return { product, images, validationError, drafts, schedules: scheduleRows.results, jobs: jobRows.results, runs: runRows.results };
}
