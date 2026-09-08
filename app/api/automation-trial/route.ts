import { fail, ok } from "../../../lib/api";
import { AutomationError, getAutomationRun, queueAutomationRun, retryAutomationRun } from "../../../lib/automation";
import { getRuntimeEnv } from "../../../lib/integrations/env";
import { syncGoogleCatalog } from "../../../lib/integrations/google-sync";
import { TAHA_WORKSPACE_ID } from "../../../lib/integrations/store";
import { isOperatorRequest } from "../../../lib/operator-auth";
import { productSources } from "../../../lib/product-integrity";

// One trial for this rollout. Retrying the request can never choose another SKU/post.
const TRIAL_KEY = "trial:drive-only-facebook-v2";
export async function POST(request: Request) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Chỉ admin được chạy thử.", 401);
  try {
    const db = getRuntimeEnv().DB;
    if (!db) throw new Error("DATABASE_UNAVAILABLE");
    const existing = await db.prepare("SELECT id FROM automation_runs WHERE workspace_id = ? AND request_key = ?")
      .bind(TAHA_WORKSPACE_ID, TRIAL_KEY).first<{ id: string }>();
    if (existing) {
      const run = await getAutomationRun(existing.id);
      // A failed pre-publication step may resume on the same SKU/run. Never undo an admin cancellation or an uncertain send.
      if (run.status === "failed" && !run.jobs.length) await retryAutomationRun(existing.id);
      return ok({ run: await getAutomationRun(existing.id), replayed: true });
    }
    await syncGoogleCatalog();
    const candidates = await db.prepare(`SELECT p.id FROM products p WHERE p.workspace_id = ? AND p.status = 'active' AND p.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.product_id = p.id AND r.status IN ('queued', 'processing'))
      ORDER BY p.base_sku LIMIT 100`).bind(TAHA_WORKSPACE_ID).all<{ id: string }>();
    for (const product of candidates.results) {
      try { await productSources(product.id); }
      catch (error) {
        if (error instanceof Error && ["PRODUCT_SOURCE_CHANGED", "PRODUCT_NOT_ACTIVE", "PRODUCT_SKU_FOLDER_MISMATCH", "SKU_SOURCE_IMAGES_REQUIRED"].includes(error.message)) continue;
        throw error;
      }
      return ok(await queueAutomationRun({ productId: product.id, targetProviders: ["facebook"], imageCount: 0, idempotencyKey: TRIAL_KEY }, "authorized-facebook-trial"), { status: 202 });
    }
    return fail("NO_READY_PRODUCT", "Chưa có SKU đang bán với ảnh Drive khớp thư mục.", 409);
  } catch (error) {
    if (error instanceof AutomationError) return fail(error.code, error.userMessage, error.status);
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "TRIAL_FAILED";
    return fail(code, "Chưa thể chạy thử. Kiểm tra kết nối Google, Facebook và dữ liệu sản phẩm.", 409);
  }
}
