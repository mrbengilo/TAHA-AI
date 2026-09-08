"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "../../SiteLink";
import type { getProductFolder } from "../../../lib/product-folder";
import { customerCopyViolation, customerCopyWordCount } from "../../../lib/ai/shoe-content";

type Folder = Awaited<ReturnType<typeof getProductFolder>> & { canReview: boolean };
type Draft = Folder["drafts"][number];
const labels: Record<string, string> = { queued: "Đang chờ", processing: "Đang chuẩn bị ảnh và bài", draft: "Bản nháp", approved: "Sẵn sàng đăng", rejected: "Không cho đăng", active: "Đã lên lịch", paused: "Đã tạm dừng", completed: "Đã chuẩn bị xong", publishing: "Đang gửi", published: "Đã đăng", cancelled: "Đã hủy", retry_wait: "Đang thử lại", blocked: "Cần kiểm tra", failed: "Có lỗi", awaiting_confirmation: "Chờ xác nhận thủ công" };
function date(value: number) { return new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh" }).format(value); }
function kilobytes(value: number) { return `${(Math.floor(value / 100) / 10).toLocaleString("vi-VN")} KB`; }
const sceneLabels: Record<string, string> = { cycling: "Đạp xe", running: "Chạy bộ", climbing: "Leo núi", stream: "Vượt suối" };
const contentErrors: Record<string, string> = {
  CONTENT_PRICE_FORBIDDEN: "Chưa đăng: bài còn giá hoặc lời mời báo giá. Sửa và lưu bài, rồi bấm Đăng lại.",
  CONTENT_INTERNAL_TEXT_FORBIDDEN: "Chưa đăng: bài còn thông tin quy trình nội bộ. Sửa và lưu bài, rồi bấm Đăng lại.",
  CONTENT_WORD_LIMIT_EXCEEDED: "Chưa đăng: bài vượt 2.000 từ. Rút gọn và lưu bài, rồi bấm Đăng lại.",
};
async function api<T = Folder>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const payload = await response.json() as { data: T; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || "Thao tác chưa thành công.");
  return payload.data;
}

export default function ProductFolder({ productId }: { productId: string }) {
  const [folder, setFolder] = useState<Folder | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Draft | null>(null);
  const [tags, setTags] = useState("");
  const requestKey = useRef<string | null>(null);
  const editingCopy = editing ? { title: editing.title || "", body: editing.body, hashtags: tags.split(/[\s,]+/).filter(Boolean) } : null;
  const plannedGeneratedImages = folder ? Math.min(4, Math.max(0, 6 - folder.images.length)) : 0;
  const editViolation = editingCopy ? customerCopyViolation(editingCopy) : null;
  const editWords = editingCopy ? customerCopyWordCount([editingCopy.title, editingCopy.body, ...editingCopy.hashtags].join(" ")) : 0;
  const refresh = useCallback(async () => {
    try { setFolder(await api(`/api/products/${encodeURIComponent(productId)}`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Không tải được sản phẩm."); }
  }, [productId]);
  useEffect(() => { const timer = setTimeout(() => void refresh(), 0); return () => clearTimeout(timer); }, [refresh]);
  const active = folder?.runs.some((run) => ["queued", "processing"].includes(run.status));
  const scheduled = folder?.schedules.some((schedule) => schedule.status === "active");
  const sending = folder?.jobs.some((job) => ["queued", "retry_wait", "publishing"].includes(job.status));
  useEffect(() => {
    if (!active && !scheduled && !sending) return;
    const timer = setInterval(() => void refresh(), 8000); return () => clearInterval(timer);
  }, [active, scheduled, sending, refresh]);
  async function confirm() {
    if (busy) return;
    setBusy("confirm"); setError(""); setNotice("");
    requestKey.current ??= `confirm:${productId}:${crypto.randomUUID()}`;
    try {
      await api("/api/automation-runs", { method: "POST", body: JSON.stringify({ productId, targetProviders: ["facebook"], imageCount: 4, idempotencyKey: requestKey.current }) });
      setNotice("Đã xác nhận. Hệ thống dùng tối đa 6 ảnh đúng SKU, chỉ tạo thêm ảnh bối cảnh khi cần, viết bài không giá, chọn hashtag và lên lịch Facebook. Bạn có thể đóng trang.");
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Không thể xác nhận."); }
    finally { setBusy(""); }
  }
  async function review(draft: Draft, action: "edit" | "reject") {
    if (busy) return;
    setBusy(`${action}:${draft.id}`); setError(""); setNotice("");
    try {
      await api(`/api/content-drafts/${encodeURIComponent(draft.id)}`, { method: "PATCH", body: JSON.stringify({ action, version: draft.version, title: draft.title, body: draft.body, hashtags: tags.split(/[\s,]+/).filter(Boolean) }) });
      setNotice(action === "reject" ? "Đã chặn bài viết và hủy lịch/công việc đang chờ của bài này." : "Đã lưu bài viết. Lịch tự động sẽ dùng nội dung mới.");
      setEditing(null); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Không thể cập nhật."); await refresh(); }
    finally { setBusy(""); }
  }
  async function retryFacebook(draft: Draft, connectionId: string) {
    if (busy) return;
    if (!window.confirm(`Đăng lại bài ${folder?.product.base_sku || ""} đã sửa lên Facebook?`)) return;
    setBusy(`retry:${draft.id}`); setError(""); setNotice("");
    try {
      const result = await api<{ status: string }>("/api/publish/facebook", {
        method: "POST", body: JSON.stringify({ draftId: draft.id, connectionId }),
      });
      setNotice(result.status === "published" ? "Bài đã được đăng; không gửi thêm bản trùng."
        : "Đã đưa bài đã sửa vào hàng đợi. Kết quả và liên kết sẽ xuất hiện khi Facebook xác nhận.");
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Chưa thể đăng lại bài."); }
    finally { setBusy(""); }
  }
  if (!folder) return <div className="ui-panel"><p role={error ? "alert" : "status"}>{error || "Đang tải thư mục sản phẩm…"}</p></div>;
  return <div className="sku-folder">
    <section className="ui-page-header"><div className="ui-page-header-copy"><span className="ui-eyebrow">THƯ MỤC SKU {folder.product.base_sku}</span><h1>{folder.product.name}</h1><p>Google Sheets · SKU {folder.product.base_sku} · Ảnh và bài viết của cùng sản phẩm</p></div>
      {folder.canReview && <button type="button" className="ui-button is-primary" aria-busy={busy === "confirm"} disabled={!!busy || !!active || !!scheduled || !!sending || !!folder.validationError} onClick={() => void confirm()}>{busy === "confirm" ? "Đang xác nhận…" : active ? "Đang chuẩn bị ảnh và bài…" : scheduled || sending ? "Đã có lịch đăng tự động" : "Xác nhận · Chuẩn bị tối đa 6 ảnh và bài"}</button>}
    </section>
    {notice && <div className="automation-alert is-success" role="status">{notice}</div>}
    {error && <div className="automation-alert is-error" role="alert">{error}</div>}
    {folder.validationError && <div className="ui-panel" role="alert">Chưa đủ dữ liệu khớp SKU để đăng. Cần sản phẩm đang bán trong Sheet và ít nhất một ảnh gốc trong thư mục Drive đúng SKU. <Link href="/connections">Kiểm tra và đồng bộ Google</Link></div>}
    <div className="sku-columns">
      <section className="ui-panel sku-source"><h2>Ảnh gốc · SKU {folder.product.base_sku}</h2><p>{folder.images.length} ảnh đúng SKU · {folder.images.filter((image) => image.optimized).length} ảnh đã dưới 300 KB</p><div className="sku-images">{folder.images.map((image) => <a href={image.previewUrl} target="_blank" rel="noreferrer" key={image.id}><img src={image.previewUrl} alt={`${folder.product.base_sku} · ${image.filename}`} loading="lazy" width={480} height={480}/><span>{image.filename}</span><small>{image.optimized && image.byteSize ? kilobytes(image.byteSize) : "Chờ tối ưu dung lượng"}</small></a>)}</div>
        <h2>Ảnh bối cảnh · SKU {folder.product.base_sku}</h2><p>{plannedGeneratedImages ? `Tạo thêm ${plannedGeneratedImages} ảnh khi cần · Tổng ảnh đăng tối đa 6` : "Đã có ít nhất 6 ảnh gốc · Không cần tạo thêm ảnh"}</p>
        {folder.generatedImages.length ? <div className="sku-images is-generated">{folder.generatedImages.map((image) => <a href={image.previewUrl} target="_blank" rel="noreferrer" key={image.id}><img src={image.previewUrl} alt={`${folder.product.base_sku} · ${sceneLabels[image.variant] || image.variant}`} loading="lazy" width={480} height={480}/><span>{sceneLabels[image.variant] || image.filename}</span><small>{kilobytes(image.byteSize)}</small></a>)}</div> : <p className="sku-editor-hint">{folder.imageValidationError ? "Bộ ảnh cần được đối chiếu lại với sản phẩm hiện tại." : plannedGeneratedImages ? `Hệ thống sẽ tạo thêm ${plannedGeneratedImages} ảnh, mỗi ảnh dưới 200 KB.` : "Hệ thống chỉ viết bài và dùng tối đa 6 ảnh gốc để đăng."}</p>}
        <h2>Thông tin từ Google Sheets</h2><p className="sku-body">{folder.product.description || "Sheet chưa có mô tả bổ sung. AI chỉ sử dụng các thông tin đã có của sản phẩm."}</p>
      </section>
      <section className="sku-articles"><h2>Bài viết và mô tả · SKU {folder.product.base_sku}</h2>
        {folder.runs.filter((run) => ["queued", "processing", "failed"].includes(run.status)).map((run) => <div className="ui-panel" key={run.id} role="status"><strong>{labels[run.status]}</strong>{run.requested_image_count > 0 && <p>{run.completed_image_count}/{run.requested_image_count} ảnh đã hoàn tất</p>}<p>{run.error_message || "Máy chủ tự xử lý; bạn không cần giữ trang này mở."}</p>{run.error_code && <small>{run.error_code}</small>}</div>)}
        {!folder.drafts.length && <div className="ui-panel">Chưa có bài viết. Xác nhận sản phẩm để hệ thống tự chuẩn bị.</div>}
        {folder.drafts.map((draft) => {
          const schedule = folder.schedules.find((item) => item.draft_id === draft.id);
          const jobs = folder.jobs.filter((item) => item.draft_id === draft.id);
          const locked = jobs.some((job) => ["publishing", "published"].includes(job.status));
          const canRetryFacebook = draft.target_provider === "facebook" && draft.status === "approved" && !locked
            && jobs.some((job) => job.status === "failed" && !!contentErrors[job.error_code || ""]);
          const draftViolation = customerCopyViolation({ title: draft.title || "", body: draft.body, hashtags: draft.hashtags });
          return <article className="ui-panel sku-article" key={draft.id}>
            <div className="sku-article-heading"><strong>{draft.target_provider === "facebook" ? "Facebook" : draft.target_provider}</strong><span className={`ui-status ${draft.status === "rejected" ? "is-warning" : "is-success"}`}>{labels[draft.status] || draft.status}</span></div>
            {editing?.id === draft.id ? <form onSubmit={(event) => { event.preventDefault(); void review(editing, "edit"); }}><label>Tiêu đề<input required maxLength={180} value={editing.title || ""} onChange={(event) => setEditing({ ...editing, title: event.target.value })}/></label><label>Bài viết<textarea required maxLength={20000} rows={9} value={editing.body} onChange={(event) => setEditing({ ...editing, body: event.target.value })}/></label><p className={editViolation ? "sku-error" : "sku-editor-hint"} role={editViolation ? "alert" : "status"}>{editWords}/2.000 từ · Không giá{editViolation === "CONTENT_PRICE_FORBIDDEN" ? " — Hãy bỏ giá hoặc lời mời báo giá." : editViolation === "CONTENT_WORD_LIMIT_EXCEEDED" ? " — Bài vượt giới hạn từ." : editViolation ? " — Hãy bỏ thông tin quy trình nội bộ." : ""}</p><label>Hashtag<input required value={tags} onChange={(event) => setTags(event.target.value)}/></label><div className="ui-inline-actions"><button className="ui-button is-primary" type="submit" disabled={!!busy || !!editViolation} aria-busy={busy === `edit:${draft.id}`}>{busy ? "Đang lưu…" : "Lưu thay đổi"}</button><button type="button" className="ui-button" disabled={!!busy} onClick={() => setEditing(null)}>Hủy sửa</button></div></form>
              : <><h3>{draft.title}</h3><p className="sku-body">{draft.body}</p><p className="sku-tags">{draft.hashtags.map((tag) => `#${tag.replace(/^#+/, "")}`).join(" ")}</p>{draft.productDescription && <details><summary>Mô tả sản phẩm AI đã viết</summary><p className="sku-body">{draft.productDescription}</p></details>}</>}
            {schedule && <p className="sku-schedule">{labels[schedule.status] || schedule.status} · {date(schedule.next_run_at || schedule.run_at)} (giờ Việt Nam)<br/>{schedule.destination}</p>}
            {jobs.map((job) => <p key={job.id} role="status">{labels[job.status] || job.status}{job.external_url && <> · <a href={job.external_url} target="_blank" rel="noreferrer">Xem bài đã đăng</a></>}{job.status === "awaiting_confirmation" && draft.target_provider === "zalo_personal" && <> · <Link className="ui-button" href={`/channels/zalo_personal?tab=activity&job=${encodeURIComponent(job.id)}`}>Mở bài Zalo cần xử lý</Link></>}{job.error_code === "FACEBOOK_API_403" || job.error_code === "FACEBOOK_SCOPES_MISSING" ? <span className="sku-error">Facebook chưa cho phép đăng bài. <Link href="/connections">Kiểm tra quyền và kết nối lại Page</Link>.</span> : job.error_code && contentErrors[job.error_code] ? <span className="sku-error">{contentErrors[job.error_code]}</span> : job.error_message && <span className="sku-error">{job.error_message} ({job.error_code})</span>}</p>)}
            {folder.canReview && canRetryFacebook && schedule && editing?.id !== draft.id && <div className="ui-inline-actions"><button type="button" className="ui-button is-primary" disabled={!!busy || !!draftViolation} aria-busy={busy === `retry:${draft.id}`} onClick={() => void retryFacebook(draft, schedule.connection_id)}>{busy === `retry:${draft.id}` ? "Đang gửi yêu cầu…" : "Đăng lại Facebook"}</button>{draftViolation && <span className="sku-error">Sửa và lưu nội dung hợp lệ để đăng lại.</span>}</div>}
            {folder.canReview && draft.status !== "rejected" && !locked && editing?.id !== draft.id && <div className="ui-inline-actions"><button type="button" className="ui-button" disabled={!!busy} onClick={() => { setEditing(draft); setTags(draft.hashtags.map((tag) => `#${tag.replace(/^#+/, "")}`).join(" ")); }}>Sửa bài</button><button type="button" className="ui-button is-danger" aria-busy={busy === `reject:${draft.id}`} disabled={!!busy} onClick={() => void review(draft, "reject")}>{busy === `reject:${draft.id}` ? "Đang chặn…" : "Không cho đăng"}</button></div>}
          </article>;
        })}
      </section>
    </div>
  </div>;
}
