import { AutomationError, queueAutomationRun } from "./automation";
import { LIFESTYLE_PROMPT_VERSION } from "./image-compression";
import { getRuntimeEnv } from "./integrations/env";
import { TAHA_WORKSPACE_ID } from "./integrations/store";
import { objectJson, productFingerprint, productSources } from "./product-integrity";

export async function prepareCatalogPage(input: { cursor?: unknown; limit?: unknown }, actorId = "catalog-preparation") {
  const cursor = input.cursor ?? "";
  const limit = input.limit ?? 5;
  if (typeof cursor !== "string" || cursor.length > 120 || typeof limit !== "number"
    || !Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new AutomationError("INVALID_CATALOG_PAGE", "Mỗi lượt chuẩn bị từ 1 đến 10 SKU.");
  }
  const db = getRuntimeEnv().DB;
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  const rows = await db.prepare(`SELECT id, base_sku FROM products
    WHERE workspace_id = ? AND deleted_at IS NULL AND status = 'active' AND id > ?
    ORDER BY id LIMIT ?`).bind(TAHA_WORKSPACE_ID, cursor, limit + 1)
    .all<{ id: string; base_sku: string }>();
  const page = rows.results.slice(0, limit);
  const results: Array<{ productId: string; sku: string; runId?: string; status?: string; replayed?: boolean; errorCode?: string }> = [];
  // Serial queuing bounds DB and source validation work. The existing worker
  // performs the expensive operations later with its lease and retry guards.
  for (const row of page) {
    try {
      const source = await productSources(row.id);
      const versions = source.images.map((image) => {
        const metadata = objectJson(image.metadata_json);
        return [image.id, image.external_id, metadata.md5Checksum || metadata.modifiedTime || ""];
      });
      const bytes = new TextEncoder().encode(JSON.stringify([await productFingerprint(source.product), versions]));
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) => n.toString(16).padStart(2, "0")).join("");
      const queued = await queueAutomationRun({ productId: row.id, imageCount: 4, prepareOnly: true,
        targetProviders: ["facebook"], idempotencyKey: `catalog:${LIFESTYLE_PROMPT_VERSION}:${row.id}:${hash}` }, actorId);
      results.push({ productId: row.id, sku: row.base_sku, runId: queued.run.id, status: queued.run.status, replayed: queued.replayed });
    } catch (error) {
      const code = error instanceof AutomationError ? error.code : error instanceof Error ? error.message : "CATALOG_PREPARATION_FAILED";
      results.push({ productId: row.id, sku: row.base_sku,
        errorCode: /^[A-Z][A-Z0-9_]{1,80}$/.test(code) ? code : "CATALOG_PREPARATION_FAILED" });
    }
  }
  return { results, nextCursor: rows.results.length > limit ? page[page.length - 1].id : null };
}
