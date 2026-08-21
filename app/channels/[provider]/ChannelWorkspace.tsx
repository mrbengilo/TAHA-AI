"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  channelDefinitions,
  contentStatusLabel,
  formatDate,
  statusLabel,
  type ChannelId,
} from "../channel-data";

type ChannelCounts = { media: number; products: number; drafts: number; queued: number; published: number };
type Connection = { id: string; displayName: string; status: string; externalAccountId?: string | null };
type ChannelSummary = {
  id: ChannelId;
  name: string;
  status: string;
  connectionId: string | null;
  connections?: Connection[];
  counts: ChannelCounts;
  lastActivityAt: number | string | null;
  actions?: string[];
};
type ChannelMedia = {
  id: string;
  mediaType: "image" | "video";
  mimeType: string | null;
  byteSize: number | null;
  filename: string;
  status: string;
  origin: string;
  createdAt: number | string;
  downloadUrl: string;
};
type ChannelDraft = {
  id: string;
  productId: string;
  productName: string;
  contentType: string;
  title: string | null;
  body: string;
  hashtags: string[];
  status: string;
  updatedAt: number | string;
};
type ChannelJob = {
  id: string;
  draftId: string | null;
  status: string;
  jobKind: string;
  scheduledFor: number | string;
  externalUrl: string | null;
  errorMessage: string | null;
  payload: { message: string; mediaIds: string[] } | null;
};
type ChannelProduct = { id: string; name: string; baseSku: string; status: string };
type ChannelDetail = {
  channel: ChannelSummary;
  stats: ChannelCounts;
  media: ChannelMedia[];
  drafts: ChannelDraft[];
  jobs: ChannelJob[];
  products: ChannelProduct[];
};
type ApiPayload<T> = { data?: T; error?: { message?: string } };
type TabId = "overview" | "content" | "media" | "activity";

const tabs: { id: TabId; label: string }[] = [
  { id: "overview", label: "Tổng quan" },
  { id: "content", label: "Bài viết" },
  { id: "media", label: "Hình ảnh" },
  { id: "activity", label: "Lịch sử" },
];

const importTargetIds = new Set<ChannelId>(["facebook", "zalo_personal", "tiktok_shop", "shopee", "website"]);
const acceptedUploadTypes = ".jpg,.jpeg,.png,.webp,.gif,.mp4,.webm,.mov,image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime";

function bytesLabel(value: number | null) {
  if (!value) return "Không rõ dung lượng";
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function contentTypeFor(provider: ChannelId) {
  if (provider === "tiktok_shop" || provider === "shopee" || provider === "google_sheets") return "product_listing";
  if (provider === "website" || provider === "google_drive") return "website_article";
  return "social_post";
}

function publishLabel(provider: ChannelId) {
  if (provider === "zalo_personal") return "Chuẩn bị đăng Zalo";
  if (provider === "website") return "Gửi sang website";
  return "Đăng lên Facebook";
}

function occurrenceAt(value: number | string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function deterministicPublishKey(provider: ChannelId, connectionId: string, draft: ChannelDraft, mediaIds: string[]) {
  const parts = [provider, connectionId, draft.id, occurrenceAt(draft.updatedAt), ...mediaIds.toSorted()];
  return `channel-publish-v1:${parts.map((part) => encodeURIComponent(part)).join(":")}`;
}

export function ChannelWorkspace({
  provider,
  initialTab,
  openComposer = false,
}: {
  provider: ChannelId;
  initialTab?: TabId;
  openComposer?: boolean;
}) {
  const definition = channelDefinitions[provider];
  const [detail, setDetail] = useState<ChannelDetail | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>(initialTab ?? (provider === "google_drive" ? "media" : "overview"));
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [selectedMediaIds, setSelectedMediaIds] = useState<string[]>([]);
  const [sourceMedia, setSourceMedia] = useState<ChannelMedia[]>([]);
  const [selectedSourceMediaIds, setSelectedSourceMediaIds] = useState<string[]>([]);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [showSourceImporter, setShowSourceImporter] = useState(false);
  const [showComposer, setShowComposer] = useState(openComposer);
  const [showUploader, setShowUploader] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const loadChannel = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/channels/${encodeURIComponent(provider)}?limit=50`, {
        headers: { accept: "application/json" },
      });
      const payload = await response.json() as ApiPayload<ChannelDetail>;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message || "Không thể tải kho kênh này.");
      const nextDetail = payload.data;
      setDetail(nextDetail);
      const connectedAccounts = (nextDetail.channel.connections ?? []).filter((connection) => connection.status === "connected");
      setSelectedConnectionId((current) => {
        if (connectedAccounts.some((connection) => connection.id === current)) return current;
        if (connectedAccounts.some((connection) => connection.id === nextDetail.channel.connectionId)) {
          return nextDetail.channel.connectionId ?? "";
        }
        return connectedAccounts[0]?.id ?? "";
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Không thể tải kho kênh này.");
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    const task = window.setTimeout(() => void loadChannel(), 0);
    return () => window.clearTimeout(task);
  }, [loadChannel]);

  async function syncSource() {
    setBusy("sync");
    setNotice(null);
    try {
      const response = await fetch("/api/integrations/google/sync", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(selectedConnectionId ? { connectionId: selectedConnectionId } : {}),
      });
      const payload = await response.json() as ApiPayload<unknown>;
      if (!response.ok) throw new Error(payload.error?.message || "Không thể đồng bộ Google lúc này.");
      setNotice({ tone: "success", text: `${definition.name} đã nhận dữ liệu mới nhất.` });
      await loadChannel(true);
    } catch (reason) {
      setNotice({ tone: "error", text: reason instanceof Error ? reason.message : "Không thể đồng bộ Google lúc này." });
    } finally {
      setBusy(null);
    }
  }

  async function createDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const body = String(values.get("body") || "").trim();
    const productId = String(values.get("productId") || "").trim();
    if (!productId || !body) {
      setNotice({ tone: "error", text: "Hãy chọn sản phẩm và nhập nội dung trước khi lưu." });
      return;
    }
    setBusy("draft");
    setNotice(null);
    try {
      const response = await fetch(`/api/channels/${encodeURIComponent(provider)}/drafts`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          productId,
          title: String(values.get("title") || "").trim() || undefined,
          body,
          contentType: contentTypeFor(provider),
          hashtags: String(values.get("hashtags") || "").split(/[\s,]+/).map((item) => item.replace(/^#/, "").trim()).filter(Boolean),
        }),
      });
      const payload = await response.json() as ApiPayload<{ draft: ChannelDraft }>;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message || "Không thể lưu bản nháp.");
      form.reset();
      setShowComposer(false);
      setNotice({ tone: "success", text: "Bản nháp đã được lưu đúng vào kho của kênh này." });
      await loadChannel(true);
    } catch (reason) {
      setNotice({ tone: "error", text: reason instanceof Error ? reason.message : "Không thể lưu bản nháp." });
    } finally {
      setBusy(null);
    }
  }

  async function uploadMedia(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setNotice({ tone: "error", text: "Hãy chọn một hình ảnh hoặc video để tải lên." });
      return;
    }
    setBusy("upload");
    setNotice(null);
    try {
      const response = await fetch(`/api/channels/${encodeURIComponent(provider)}/upload`, {
        method: "POST",
        headers: { accept: "application/json" },
        body: formData,
      });
      const payload = await response.json() as ApiPayload<{ media: ChannelMedia }>;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message || "Không thể tải tệp lên.");
      form.reset();
      setShowUploader(false);
      setNotice({ tone: "success", text: "Tệp đã được lưu vào kho hình ảnh của kênh." });
      await loadChannel(true);
    } catch (reason) {
      setNotice({ tone: "error", text: reason instanceof Error ? reason.message : "Không thể tải tệp lên." });
    } finally {
      setBusy(null);
    }
  }

  async function loadSourceLibrary() {
    setShowSourceImporter(true);
    setSourceLoading(true);
    setSourceError(null);
    try {
      const response = await fetch("/api/channels/google_drive?limit=100", { headers: { accept: "application/json" } });
      const payload = await response.json() as ApiPayload<ChannelDetail>;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message || "Không thể tải ảnh nguồn từ Google Drive.");
      setSourceMedia(payload.data.media.filter((item) => item.mediaType === "image" && item.status === "ready"));
    } catch (reason) {
      setSourceError(reason instanceof Error ? reason.message : "Không thể tải ảnh nguồn từ Google Drive.");
    } finally {
      setSourceLoading(false);
    }
  }

  async function importSourceMedia() {
    if (selectedSourceMediaIds.length === 0) {
      setSourceError("Hãy chọn ít nhất một ảnh nguồn.");
      return;
    }
    setBusy("source-import");
    setSourceError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/channels/${encodeURIComponent(provider)}/media/import`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ mediaIds: selectedSourceMediaIds.toSorted() }),
      });
      const payload = await response.json() as ApiPayload<{ imported: number; alreadyLinked: number }>;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message || "Không thể nhập ảnh vào kênh.");
      setNotice({
        tone: "success",
        text: `Đã thêm ${payload.data.imported} ảnh vào ${definition.name}${payload.data.alreadyLinked > 0 ? `; ${payload.data.alreadyLinked} ảnh đã có sẵn` : ""}.`,
      });
      setSelectedSourceMediaIds([]);
      setShowSourceImporter(false);
      await loadChannel(true);
    } catch (reason) {
      setSourceError(reason instanceof Error ? reason.message : "Không thể nhập ảnh vào kênh.");
    } finally {
      setBusy(null);
    }
  }

  async function confirmZaloJob(job: ChannelJob, result: "published" | "failed") {
    const action = result === "published" ? "xác nhận đã đăng" : "đánh dấu không đăng được";
    if (!window.confirm(`Bạn muốn ${action} bài Zalo này?`)) return;
    setBusy(`confirm:${job.id}:${result}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/publish-jobs/${encodeURIComponent(job.id)}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ result }),
      });
      const payload = await response.json() as ApiPayload<{ id: string; status: string }>;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message || "Không thể xác nhận bài Zalo.");
      setNotice({ tone: "success", text: result === "published" ? "Đã ghi nhận bài Zalo được đăng." : "Đã ghi nhận bài Zalo không đăng được." });
      await loadChannel(true);
    } catch (reason) {
      setNotice({ tone: "error", text: reason instanceof Error ? reason.message : "Không thể xác nhận bài Zalo." });
    } finally {
      setBusy(null);
    }
  }

  async function copyZaloCaption(job: ChannelJob) {
    const caption = job.payload?.message.trim();
    if (!caption) {
      setNotice({ tone: "error", text: "Bài Zalo này chưa có caption để sao chép." });
      return;
    }
    try {
      await navigator.clipboard.writeText(caption);
      setNotice({ tone: "success", text: "Đã sao chép caption Zalo. Hãy dán vào ứng dụng Zalo chính thức." });
    } catch {
      setNotice({ tone: "error", text: "Trình duyệt chưa cho phép sao chép. Hãy chọn caption và sao chép thủ công." });
    }
  }

  async function publishDraft(draft: ChannelDraft) {
    const connectionId = selectedConnectionId;
    if (!connectionId) {
      setNotice({ tone: "error", text: "Kênh chưa có tài khoản hoạt động. Hãy kết nối trước khi đăng." });
      return;
    }
    const destination = detail?.channel.connections?.find((connection) => connection.id === connectionId);
    if (!destination) {
      setNotice({ tone: "error", text: "Tài khoản đích không còn hoạt động. Hãy chọn lại tài khoản." });
      return;
    }
    const destinationName = destination.externalAccountId
      ? `${destination.displayName} (${destination.externalAccountId})`
      : destination.displayName;
    const confirmed = window.confirm(`Bạn xác nhận ${publishLabel(provider).toLocaleLowerCase("vi-VN")} nội dung “${draft.title || draft.productName}” đến đúng tài khoản “${destinationName}”?`);
    if (!confirmed) return;
    const endpoint = provider === "facebook"
      ? "/api/publish/facebook"
      : provider === "zalo_personal"
        ? "/api/publish/zalo-personal/prepare"
        : "/api/publish/website";
    const sortedMediaIds = selectedMediaIds.toSorted();
    const idempotencyKey = deterministicPublishKey(provider, connectionId, draft, sortedMediaIds);
    const message = [draft.title, draft.body, draft.hashtags.map((tag) => `#${tag}`).join(" ")].filter(Boolean).join("\n\n");
    const requestBody = provider === "website"
      ? {
          connectionId,
          payload: {
            provider,
            contentType: draft.contentType,
            title: draft.title || draft.productName,
            message,
            body: draft.body,
            hashtags: draft.hashtags,
            mediaIds: sortedMediaIds,
            productId: draft.productId,
            draftId: draft.id,
            platformData: {},
            publishOptions: {},
            occurrenceAt: occurrenceAt(draft.updatedAt),
          },
          idempotencyKey,
        }
      : { connectionId, message, mediaIds: sortedMediaIds, idempotencyKey };
    setBusy(`publish:${draft.id}`);
    setNotice(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(requestBody),
      });
      const payload = await response.json() as ApiPayload<unknown>;
      if (!response.ok) throw new Error(payload.error?.message || "Kênh chưa nhận được nội dung.");
      const successText = provider === "zalo_personal"
        ? "Bài Zalo đã được chuẩn bị. Hãy mở mục lịch sử để xác nhận sau khi đăng thủ công."
        : "Nội dung đã được gửi sang kênh và lưu trong lịch sử.";
      setNotice({ tone: "success", text: successText });
      setActiveTab("activity");
      await loadChannel(true);
    } catch (reason) {
      setNotice({ tone: "error", text: reason instanceof Error ? reason.message : "Kênh chưa nhận được nội dung." });
    } finally {
      setBusy(null);
    }
  }

  function toggleMedia(id: string) {
    setSelectedMediaIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function toggleSourceMedia(id: string) {
    if (selectedSourceMediaIds.includes(id)) {
      setSelectedSourceMediaIds((current) => current.filter((item) => item !== id));
      return;
    }
    if (selectedSourceMediaIds.length >= 20) {
      setSourceError("Mỗi lần chỉ có thể chọn tối đa 20 ảnh.");
      return;
    }
    setSourceError(null);
    setSelectedSourceMediaIds((current) => [...current, id]);
  }

  if (loading) {
    return (
      <main className="ch-page ch-detail-page">
        <div className="ch-detail-loading" aria-busy="true"><i /><strong>Đang mở kho {definition.name}…</strong><span>TAHA AI đang lấy bài viết và hình ảnh mới nhất.</span></div>
      </main>
    );
  }

  if (error || !detail) {
    return (
      <main className="ch-page ch-detail-page">
        <Link className="ch-back" href="/channels">← Tất cả kênh</Link>
        <div className="ch-state-card ch-error-state" role="alert">
          <span aria-hidden="true">!</span><div><strong>Chưa mở được kho {definition.name}</strong><p>{error || "Dữ liệu không tồn tại."}</p></div>
          <button type="button" onClick={() => void loadChannel()}>Thử lại</button>
        </div>
      </main>
    );
  }

  const { channel, media, drafts, jobs, products, stats } = detail;
  const connectedAccounts = (channel.connections ?? []).filter((connection) => connection.status === "connected");
  const connected = connectedAccounts.length > 0;
  const selectedConnection = connectedAccounts.find((connection) => connection.id === selectedConnectionId) ?? null;
  const targetMediaIds = new Set(media.map((item) => item.id));
  const canPublish = provider === "facebook" || provider === "zalo_personal" || provider === "website";

  return (
    <main className="ch-page ch-detail-page">
      <header className="ch-detail-header">
        <div className="ch-detail-nav">
          <Link className="ch-back" href="/channels">← Tất cả kênh</Link>
          <div>
            <Link href="/">Tổng quan</Link>
            <Link href="/connections">Kết nối</Link>
          </div>
        </div>
        <div className="ch-detail-identity">
          <span className="ch-detail-mark" style={{ background: definition.softAccent, color: definition.accent }}>{definition.mark}</span>
          <div><span className="ch-eyebrow">{definition.eyebrow}</span><h1>{definition.name}</h1><p>{definition.description}</p></div>
          <div className="ch-detail-actions">
            <span className={`ch-status ch-status-${channel.status}`}><i />{statusLabel(channel.status)}</span>
            {connectedAccounts.length > 0 ? (
              <label className="ch-connection-picker">
                <span>Tài khoản đang dùng</span>
                <select value={selectedConnectionId} onChange={(event) => setSelectedConnectionId(event.target.value)} aria-label={`Chọn tài khoản ${definition.name}`}>
                  {connectedAccounts.map((connection) => <option value={connection.id} key={connection.id}>{connection.displayName}{connection.externalAccountId ? ` · ${connection.externalAccountId}` : ""}</option>)}
                </select>
              </label>
            ) : null}
            {definition.supportsSync ? <button className="ch-primary-button" type="button" disabled={busy === "sync"} onClick={() => void syncSource()}>{busy === "sync" ? "Đang đồng bộ…" : "Đồng bộ ngay"}</button> : null}
            {definition.supportsDrafts ? <button className="ch-primary-button" type="button" onClick={() => { setActiveTab("content"); setShowComposer(true); }}>+ Tạo bản nháp</button> : null}
          </div>
        </div>
      </header>

      {!connected ? (
        <div className="ch-connect-banner">
          <span aria-hidden="true">○</span><div><strong>Kênh này chưa được kết nối</strong><p>Bạn vẫn có thể lưu bản nháp và hình ảnh. Cần kết nối tài khoản trước khi đồng bộ hoặc đăng.</p></div>
          <Link href={`/connections?provider=${definition.connectionProvider}`}>Đi đến kết nối →</Link>
        </div>
      ) : null}

      {notice ? (
        <div className={`ch-notice is-${notice.tone}`} role="status"><span>{notice.tone === "success" ? "✓" : "!"}</span><p>{notice.text}</p><button type="button" onClick={() => setNotice(null)} aria-label="Đóng thông báo">×</button></div>
      ) : null}

      <div className="ch-detail-tabs" role="tablist" aria-label={`Các mục của ${definition.name}`}>
        {tabs.map((tab) => (
          <button type="button" role="tab" id={`channel-tab-${tab.id}`} aria-controls={`channel-panel-${tab.id}`} aria-selected={activeTab === tab.id} className={activeTab === tab.id ? "is-active" : ""} key={tab.id} onClick={() => setActiveTab(tab.id)}>
            {tab.label}
            {tab.id === "content" && drafts.length > 0 ? <span>{drafts.length}</span> : null}
            {tab.id === "media" && media.length > 0 ? <span>{media.length}</span> : null}
            {tab.id === "activity" && jobs.length > 0 ? <span>{jobs.length}</span> : null}
          </button>
        ))}
      </div>

      <section className="ch-detail-content" role="tabpanel" id={`channel-panel-${activeTab}`} aria-labelledby={`channel-tab-${activeTab}`}>
        {activeTab === "overview" ? (
          <div className="ch-overview-grid">
            <div className="ch-stat-grid">
              <article><span>TÀI SẢN</span><strong>{provider === "google_sheets" ? stats.products : stats.media}</strong><p>{provider === "google_sheets" ? "dòng sản phẩm" : "hình ảnh & video"}</p></article>
              <article><span>BẢN NHÁP</span><strong>{stats.drafts}</strong><p>nội dung của riêng kênh</p></article>
              <article><span>ĐANG CHỜ</span><strong>{stats.queued}</strong><p>công việc trong hàng đợi</p></article>
              <article><span>HOÀN TẤT</span><strong>{stats.published}</strong><p>lần xuất bản thành công</p></article>
            </div>
            <article className="ch-info-panel">
              <span className="ch-eyebrow">TRẠNG THÁI KÊNH</span>
              <h2>{connected ? "Kho đã sẵn sàng làm việc" : "Có thể chuẩn bị nội dung trước"}</h2>
              <p>{connected ? `Kết nối đang hoạt động. Lần cập nhật gần nhất: ${formatDate(channel.lastActivityAt)}.` : "Ảnh và bài viết vẫn được lưu riêng tại đây, ngay cả khi bạn chưa hoàn tất kết nối tài khoản."}</p>
              <dl>
                <div><dt>Tài khoản</dt><dd>{selectedConnection?.displayName || "Chưa chọn"}</dd></div>
                <div><dt>Chế độ</dt><dd>{provider === "zalo_personal" ? "Bạn xác nhận đăng" : definition.supportsSync ? "Đồng bộ nguồn" : "Qua kết nối chính thức"}</dd></div>
                <div><dt>Cập nhật</dt><dd>{formatDate(channel.lastActivityAt)}</dd></div>
              </dl>
              <Link href="/connections">Quản lý kết nối <span aria-hidden="true">→</span></Link>
            </article>
            {provider === "google_sheets" ? (
              <article className="ch-product-panel">
                <div className="ch-panel-heading"><div><span className="ch-eyebrow">DỮ LIỆU ĐÃ ĐỌC</span><h2>Sản phẩm từ Google Sheets</h2></div><button type="button" onClick={() => void syncSource()} disabled={busy === "sync"}>Cập nhật</button></div>
                {products.length === 0 ? <div className="ch-inline-empty"><strong>Chưa có dòng sản phẩm</strong><p>Kết nối Google và bấm Đồng bộ để đọc bảng tính.</p></div> : (
                  <div className="ch-table-wrap"><table><thead><tr><th>Sản phẩm</th><th>SKU</th><th>Trạng thái</th></tr></thead><tbody>{products.map((product) => <tr key={product.id}><td>{product.name}</td><td><code>{product.baseSku}</code></td><td><span className={`ch-content-status is-${product.status}`}>{contentStatusLabel(product.status)}</span></td></tr>)}</tbody></table></div>
                )}
              </article>
            ) : null}
          </div>
        ) : null}

        {activeTab === "content" ? (
          <div className="ch-work-grid">
            <div className="ch-work-main">
              <div className="ch-panel-heading"><div><span className="ch-eyebrow">NỘI DUNG RIÊNG CỦA KÊNH</span><h2>Bài viết & bản nháp</h2></div>{definition.supportsDrafts ? <button type="button" onClick={() => setShowComposer((value) => !value)}>{showComposer ? "Đóng" : "+ Bản nháp mới"}</button> : null}</div>
              {showComposer ? (
                <form className="ch-form-card" onSubmit={createDraft}>
                  <div className="ch-form-title"><strong>Tạo nội dung cho {definition.compactName}</strong><span>Chỉ lưu trong kho kênh này</span></div>
                  <label><span>Sản phẩm <b>*</b></span><select name="productId" required defaultValue=""><option value="" disabled>Chọn sản phẩm</option>{products.map((product) => <option value={product.id} key={product.id}>{product.name} · {product.baseSku}</option>)}</select></label>
                  {products.length === 0 ? <p className="ch-form-hint">Chưa có sản phẩm. Hãy đồng bộ Google Sheets trước.</p> : null}
                  <label><span>Tiêu đề</span><input name="title" maxLength={180} placeholder={provider === "website" ? "Tiêu đề bài viết" : "Tên nội dung để dễ tìm"} /></label>
                  <label><span>Nội dung <b>*</b></span><textarea name="body" required rows={7} maxLength={20000} placeholder={`Viết nội dung dành riêng cho ${definition.name}…`} /></label>
                  <label><span>Hashtag</span><input name="hashtags" maxLength={500} placeholder="#sanpham #taha (cách nhau bằng dấu cách)" /></label>
                  <div className="ch-form-actions"><button type="button" onClick={() => setShowComposer(false)}>Hủy</button><button className="ch-primary-button" type="submit" disabled={busy === "draft" || products.length === 0}>{busy === "draft" ? "Đang lưu…" : "Lưu bản nháp"}</button></div>
                </form>
              ) : null}
              {drafts.length === 0 ? (
                <div className="ch-inline-empty ch-large-empty"><span aria-hidden="true">Aa</span><strong>Chưa có bài viết cho {definition.compactName}</strong><p>Tạo một bản nháp; nội dung sẽ không bị trộn với các kênh còn lại.</p>{definition.supportsDrafts ? <button type="button" onClick={() => setShowComposer(true)}>Tạo bản nháp đầu tiên</button> : null}</div>
              ) : (
                <div className="ch-draft-list">
                  {drafts.map((draft) => (
                    <article key={draft.id}>
                      <div className="ch-draft-top"><span className={`ch-content-status is-${draft.status}`}>{contentStatusLabel(draft.status)}</span><time>{formatDate(draft.updatedAt)}</time></div>
                      <h3>{draft.title || draft.productName}</h3><small>{draft.productName}</small><p>{draft.body}</p>
                      {draft.hashtags.length > 0 ? <div className="ch-hashtags">{draft.hashtags.map((tag) => <span key={tag}>#{tag}</span>)}</div> : null}
                      <div className="ch-draft-actions"><span>{selectedMediaIds.length} tệp đang chọn</span>{canPublish ? <button className="ch-primary-button" type="button" disabled={busy === `publish:${draft.id}` || !connected} onClick={() => void publishDraft(draft)}>{busy === `publish:${draft.id}` ? "Đang gửi…" : publishLabel(provider)}</button> : <span className="ch-muted-action">{definition.group === "source" ? "Bản nội dung tham chiếu của nguồn dữ liệu" : "Lưu nội dung trước khi bật API listing"}</span>}</div>
                    </article>
                  ))}
                </div>
              )}
            </div>
            <aside className="ch-selection-panel"><span className="ch-eyebrow">ẢNH ĐÍNH KÈM</span><h3>{selectedMediaIds.length} tệp đã chọn</h3><p>Chọn ảnh trong mục Hình ảnh, sau đó quay lại đây để đăng cùng nội dung.</p><button type="button" onClick={() => setActiveTab("media")}>Chọn hình ảnh →</button></aside>
          </div>
        ) : null}

        {activeTab === "media" ? (
          <div className="ch-work-main">
            <div className="ch-panel-heading">
              <div><span className="ch-eyebrow">KHO TÀI SẢN CỦA KÊNH</span><h2>Hình ảnh & video</h2></div>
              <div>
                {definition.supportsSync ? <button type="button" onClick={() => void syncSource()} disabled={busy === "sync"}>{busy === "sync" ? "Đang đồng bộ…" : "Đồng bộ Drive"}</button> : null}
                {importTargetIds.has(provider) ? <button type="button" onClick={() => void loadSourceLibrary()}>Chọn từ Google Drive</button> : null}
                <button type="button" onClick={() => setShowUploader((value) => !value)}>{showUploader ? "Đóng" : "+ Tải tệp"}</button>
              </div>
            </div>
            {showUploader ? (
              <form className="ch-form-card ch-upload-form" onSubmit={uploadMedia}>
                <div className="ch-form-title"><strong>Thêm tệp vào {definition.compactName}</strong><span>Ảnh và video được lưu riêng cho kênh</span></div>
                <label className="ch-file-field"><span>Tệp hình ảnh hoặc video <b>*</b></span><input type="file" name="file" accept={acceptedUploadTypes} required /></label>
                <label><span>Mô tả hình ảnh</span><input name="altText" maxLength={300} placeholder="Mô tả ngắn giúp nội dung dễ tiếp cận" /></label>
                <label><span>Gắn với sản phẩm</span><select name="productId" defaultValue=""><option value="">Không gắn sản phẩm</option>{products.map((product) => <option value={product.id} key={product.id}>{product.name} · {product.baseSku}</option>)}</select></label>
                <div className="ch-form-actions"><button type="button" onClick={() => setShowUploader(false)}>Hủy</button><button className="ch-primary-button" type="submit" disabled={busy === "upload"}>{busy === "upload" ? "Đang tải…" : "Lưu vào kho"}</button></div>
              </form>
            ) : null}
            {showSourceImporter ? (
              <section className="ch-source-import" aria-labelledby="source-import-title">
                <div className="ch-source-import-heading">
                  <div><span className="ch-eyebrow">ẢNH NGUỒN</span><h3 id="source-import-title">Chọn ảnh từ Google Drive</h3><p>Tối đa 20 ảnh mỗi lần; ảnh được liên kết vào kho {definition.compactName} mà không tạo bản sao.</p></div>
                  <button type="button" onClick={() => { setShowSourceImporter(false); setSelectedSourceMediaIds([]); setSourceError(null); }} aria-label="Đóng thư viện ảnh nguồn">×</button>
                </div>
                {sourceError ? <div className="ch-source-error" role="alert">{sourceError}</div> : null}
                {sourceLoading ? <div className="ch-source-loading" aria-busy="true"><i /><span>Đang tải ảnh nguồn…</span></div> : sourceMedia.length === 0 ? (
                  <div className="ch-inline-empty"><strong>Chưa có ảnh sẵn sàng trong Google Drive</strong><p>Đồng bộ Google Drive trước, sau đó tải lại thư viện này.</p><button type="button" onClick={() => void loadSourceLibrary()}>Tải lại</button></div>
                ) : (
                  <div className="ch-source-grid">
                    {sourceMedia.map((item) => {
                      const selected = selectedSourceMediaIds.includes(item.id);
                      const linked = targetMediaIds.has(item.id);
                      return (
                        <button type="button" className={selected ? "is-selected" : ""} aria-pressed={selected} key={item.id} onClick={() => toggleSourceMedia(item.id)}>
                          <span className="ch-source-thumb"><i>{item.filename.split(".").pop()?.toUpperCase() || "ẢNH"}</i><b>{selected ? "✓" : "+"}</b></span>
                          <span className="ch-source-name" title={item.filename}>{item.filename}</span>
                          <small>{linked ? "Đã có trong kênh" : bytesLabel(item.byteSize)}</small>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="ch-source-actions"><span>{selectedSourceMediaIds.length}/20 ảnh đã chọn</span><div><button type="button" onClick={() => void loadSourceLibrary()} disabled={sourceLoading}>Làm mới</button><button className="ch-primary-button" type="button" disabled={busy === "source-import" || selectedSourceMediaIds.length === 0} onClick={() => void importSourceMedia()}>{busy === "source-import" ? "Đang thêm…" : `Thêm ${selectedSourceMediaIds.length} ảnh vào kênh`}</button></div></div>
              </section>
            ) : null}
            {media.length === 0 ? (
              <div className="ch-inline-empty ch-large-empty"><span aria-hidden="true">▧</span><strong>Kho hình ảnh đang trống</strong><p>{definition.supportsSync ? "Đồng bộ thư mục Google Drive hoặc tải một tệp từ máy." : "Tải hình ảnh dành riêng cho kênh này để bắt đầu."}</p><button type="button" onClick={() => setShowUploader(true)}>Tải tệp đầu tiên</button></div>
            ) : (
              <div className="ch-media-grid">
                {media.map((item) => {
                  const selected = selectedMediaIds.includes(item.id);
                  return (
                    <article className={selected ? "is-selected" : ""} key={item.id}>
                      <button type="button" className="ch-media-select" onClick={() => toggleMedia(item.id)} aria-pressed={selected} aria-label={`${selected ? "Bỏ chọn" : "Chọn"} ${item.filename}`}><span>{selected ? "✓" : "+"}</span></button>
                      <div className={`ch-media-placeholder is-${item.mediaType}`}><span>{item.mediaType === "video" ? "VIDEO" : item.filename.split(".").pop()?.toUpperCase() || "ẢNH"}</span></div>
                      <div className="ch-media-meta"><div><strong title={item.filename}>{item.filename}</strong><span>{bytesLabel(item.byteSize)} · {contentStatusLabel(item.status)}</span></div><a href={item.downloadUrl} download aria-label={`Tải ${item.filename}`}>↓</a></div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}

        {activeTab === "activity" ? (
          <div className="ch-work-main">
            <div className="ch-panel-heading"><div><span className="ch-eyebrow">NHẬT KÝ XUẤT BẢN</span><h2>Hoạt động gần đây</h2></div><button type="button" onClick={() => void loadChannel(true)}>Làm mới</button></div>
            {jobs.length === 0 ? <div className="ch-inline-empty ch-large-empty"><span aria-hidden="true">↗</span><strong>Chưa có lần xuất bản</strong><p>Các lần đăng, lỗi và liên kết bài công khai sẽ xuất hiện tại đây.</p></div> : (
              <div className="ch-job-list">
                {jobs.map((job) => {
                  const awaitingZalo = provider === "zalo_personal" && job.status === "awaiting_confirmation";
                  return (
                    <article className={awaitingZalo ? "ch-zalo-job" : ""} key={job.id}>
                      <span className={`ch-job-icon is-${job.status}`}>{job.status === "published" ? "✓" : job.status === "failed" || job.status === "blocked" ? "!" : "↗"}</span>
                      <div className="ch-job-content">
                        <div><strong>{job.jobKind === "social_post" ? "Bài viết" : job.jobKind === "listing_upsert" ? "Sản phẩm" : "Công việc xuất bản"}</strong><span className={`ch-content-status is-${job.status}`}>{contentStatusLabel(job.status)}</span></div>
                        <p>{job.errorMessage || `Được tạo lúc ${formatDate(job.scheduledFor)}`}</p>
                        {awaitingZalo ? (
                          <div className="ch-zalo-confirmation">
                            <span>CAPTION ĐÃ CHUẨN BỊ</span>
                            <blockquote>{job.payload?.message || "Caption chưa sẵn sàng."}</blockquote>
                            {job.payload && job.payload.mediaIds.length > 0 ? <div className="ch-zalo-downloads">{job.payload.mediaIds.map((id, index) => <a href={`/api/media/${encodeURIComponent(id)}/download`} download key={id}>↓ Tải ảnh {index + 1}</a>)}</div> : null}
                            <div className="ch-zalo-actions">
                              <button type="button" onClick={() => void copyZaloCaption(job)}>Sao chép caption</button>
                              <button type="button" disabled={busy?.startsWith(`confirm:${job.id}:`) === true} onClick={() => void confirmZaloJob(job, "failed")}>{busy === `confirm:${job.id}:failed` ? "Đang lưu…" : "Không đăng được"}</button>
                              <button className="ch-primary-button" type="button" disabled={busy?.startsWith(`confirm:${job.id}:`) === true} onClick={() => void confirmZaloJob(job, "published")}>{busy === `confirm:${job.id}:published` ? "Đang lưu…" : "Đã đăng"}</button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                      {job.externalUrl ? <a href={job.externalUrl} target="_blank" rel="noreferrer">Xem bài ↗</a> : <time>{formatDate(job.scheduledFor)}</time>}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </section>
    </main>
  );
}
