import { fail, ok } from "../../../../../lib/api";
import { isOperatorRequest } from "../../../../../lib/operator-auth";
import { startPublishJob } from "../../../../../lib/publish-jobs";

export async function POST(request: Request) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để chuẩn bị bài Zalo.", 401);
  const body = await request.json().catch(() => null) as null | { connectionId?: unknown; message?: unknown; mediaIds?: unknown; idempotencyKey?: unknown };
  if (!body || typeof body.connectionId !== "string" || typeof body.message !== "string" || typeof body.idempotencyKey !== "string") {
    return fail("INVALID_REQUEST", "Thiếu kênh, caption hoặc mã chống đăng trùng.", 422);
  }
  const mediaIds = Array.isArray(body.mediaIds) ? body.mediaIds.filter((value): value is string => typeof value === "string").slice(0, 20) : [];
  try {
    const job = await startPublishJob({
      connectionId: body.connectionId,
      dedupeKey: body.idempotencyKey,
      jobKind: "social_post",
      status: "awaiting_confirmation",
      expectedProvider: "zalo_personal",
      expectedPublishMode: "assisted",
      payload: { message: body.message, mediaIds },
    });
    if (job.replay && job.status !== "awaiting_confirmation") return fail("IDEMPOTENCY_KEY_IN_USE", "Bài Zalo này đã được xử lý trước đó.", 409);
    const snapshotMessage = typeof job.payload.message === "string" ? job.payload.message : "";
    const snapshotMediaIds = Array.isArray(job.payload.mediaIds)
      ? job.payload.mediaIds.filter((value: unknown): value is string => typeof value === "string").slice(0, 20)
      : [];
    return ok({
      jobId: job.id,
      status: job.status,
      caption: snapshotMessage,
      imageDownloads: snapshotMediaIds.map((id: string) => `/api/media/${encodeURIComponent(id)}/download`),
      requiresHumanConfirmation: true,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "ZALO_PREPARE_FAILED";
    if (code === "CONNECTION_NOT_FOUND") return fail(code, "Chưa bật trợ lý Zalo cá nhân.", 409);
    if (code === "IDEMPOTENCY_KEY_IN_USE") return fail(code, "Mã chống đăng trùng đã được dùng cho nội dung khác.", 409);
    return fail("ZALO_PREPARE_FAILED", "Không thể chuẩn bị bài Zalo lúc này.", 500);
  }
}
