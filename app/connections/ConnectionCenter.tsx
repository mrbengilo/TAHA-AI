"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Connection = {
  id: string;
  displayName: string;
  externalAccountId: string | null;
  status: string;
  publishMode: string;
  tokenExpiresAt: number | null;
  lastVerifiedAt: number | null;
  lastSyncedAt: number | null;
  lastError: string | null;
};

type Provider = {
  id: string;
  name: string;
  shortName: string;
  description: string;
  role: string;
  publishMode: "api" | "assisted" | "export_only";
  capabilities: string[];
  callbackPath: string | null;
  setupUrl: string | null;
  setupLabel: string | null;
  accent: string;
  mark: string;
  configured: boolean;
  missing: string[];
  connections: Connection[];
};

type ApiPayload = { data?: { providers: Provider[] }; error?: { code: string; message: string; details?: { missing?: string[] } } };

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><i /><b>TA</b></span>;
}

function modeLabel(mode: Provider["publishMode"]) {
  if (mode === "assisted") return "Có xác nhận";
  if (mode === "export_only") return "Nguồn dữ liệu";
  return "Tự động qua API";
}

function statusLabel(provider: Provider) {
  if (provider.connections.some((connection) => connection.status === "connected")) return "Đã kết nối";
  if (!provider.configured) return "Chờ cấu hình";
  return "Sẵn sàng kết nối";
}

function publicVariableName(value: string) {
  const labels: Record<string, string> = {
    PUBLIC_APP_URL: "Domain HTTPS của TAHA AI", OAUTH_STATE_SECRET: "Khóa bảo vệ phiên kết nối",
    INTEGRATION_TOKEN_ENCRYPTION_KEY: "Khóa mã hóa token",
    GOOGLE_CLIENT_ID: "Google Client ID", GOOGLE_CLIENT_SECRET: "Google Client Secret",
    GOOGLE_REDIRECT_URI: "Google callback URL", GOOGLE_DRIVE_FOLDER_ID: "Thư mục Google Drive",
    GOOGLE_SHEET_ID: "Google Sheet", META_APP_ID: "Meta App ID", META_APP_SECRET: "Meta App Secret",
    META_GRAPH_API_VERSION: "Phiên bản Meta API", META_REDIRECT_URI: "Facebook callback URL",
    SHOPEE_BASE_URL: "Shopee API URL", SHOPEE_PARTNER_ID: "Shopee Partner ID",
    SHOPEE_PARTNER_KEY: "Shopee Partner Key", SHOPEE_REDIRECT_URI: "Shopee callback URL",
    TIKTOK_SHOP_APP_KEY: "TikTok Shop App Key", TIKTOK_SHOP_APP_SECRET: "TikTok Shop App Secret",
    TIKTOK_SHOP_SERVICE_ID: "TikTok Shop Service ID", TIKTOK_SHOP_REDIRECT_URI: "TikTok Shop callback URL",
    WEBSITE_BASE_URL: "Địa chỉ website", WEBSITE_PUBLISH_ENDPOINT: "Đường dẫn nhận bài",
    WEBSITE_WEBHOOK_SECRET: "Khóa webhook website",
  };
  return labels[value] ?? value;
}

function channelWorkspaces(providerId: string) {
  if (providerId === "google") {
    return [
      { href: "/channels/google_drive", label: "Kho Google Drive" },
      { href: "/channels/google_sheets", label: "Kho Google Sheet" },
    ];
  }

  const routes: Record<string, { href: string; label: string }> = {
    facebook: { href: "/channels/facebook", label: "Kho Facebook" },
    zalo_personal: { href: "/channels/zalo_personal", label: "Kho Zalo" },
    tiktok_shop: { href: "/channels/tiktok_shop", label: "Kho TikTok" },
    shopee: { href: "/channels/shopee", label: "Kho Shopee" },
    website: { href: "/channels/website", label: "Kho website" },
  };

  return routes[providerId] ? [routes[providerId]] : [];
}

export function ConnectionCenter() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/integrations", { headers: { accept: "application/json" } });
      const payload = await response.json() as ApiPayload;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message || "Không tải được trạng thái kết nối.");
      setProviders(payload.data.providers);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Không tải được trạng thái kết nối." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => {
      void refresh();
      const query = new URLSearchParams(window.location.search);
      const result = query.get("result");
      if (result === "connected") setNotice({ tone: "success", text: "Kết nối đã hoàn tất và được lưu an toàn." });
      if (result === "error") setNotice({ tone: "error", text: query.get("message") || "Kết nối chưa hoàn tất. Vui lòng thử lại." });
    }, 0);
    return () => window.clearTimeout(task);
  }, [refresh]);

  const connectedCount = providers.filter(
    (provider) => provider.connections.some((connection) => connection.status === "connected"),
  ).length;

  async function connect(provider: Provider) {
    setBusy(provider.id);
    setNotice(null);
    try {
      const response = await fetch(`/api/integrations/${provider.id}/connect`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ returnTo: "/connections" }),
      });
      const payload = await response.json() as { data?: { authorizationUrl?: string; redirectTo?: string }; error?: ApiPayload["error"] };
      if (!response.ok || !payload.data) {
        const missing = payload.error?.details?.missing?.map(publicVariableName).join(", ");
        throw new Error(missing ? `Cần bổ sung trên máy chủ: ${missing}.` : payload.error?.message || "Không thể bắt đầu kết nối.");
      }
      if (payload.data.authorizationUrl) { window.location.assign(payload.data.authorizationUrl); return; }
      if (payload.data.redirectTo) { window.location.assign(payload.data.redirectTo); return; }
      await refresh();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Không thể bắt đầu kết nối." });
    } finally {
      setBusy(null);
    }
  }

  async function syncGoogle() {
    setBusy("google-sync");
    setNotice(null);
    try {
      const response = await fetch("/api/integrations/google/sync", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: "{}",
      });
      const payload = await response.json() as ApiPayload;
      if (!response.ok) throw new Error(payload.error?.message || "Không thể đồng bộ Google Drive và Sheet.");
      setNotice({ tone: "success", text: "Đã đồng bộ dữ liệu mới nhất từ Google Drive và Google Sheet." });
      await refresh();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Không thể đồng bộ Google Drive và Sheet." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="connections-page">
      <aside className="connections-aside">
        <Link className="brand connections-brand" href="/"><BrandMark /><div><strong>TAHA</strong><span>AI Commerce</span></div></Link>
        <Link className="back-link" href="/"><span>←</span> Quay lại tổng quan</Link>
        <Link className="back-link" href="/channels"><span>▦</span> Kho nội dung từng kênh</Link>
        <Link className="back-link" href="/connections/guide"><span>?</span> Hướng dẫn kết nối</Link>
        <div className="setup-progress">
          <span>TIẾN ĐỘ THIẾT LẬP</span><strong>{connectedCount}/{providers.length || 6} kênh sẵn sàng</strong>
          <div><i style={{ width: `${Math.round((connectedCount / Math.max(providers.length, 6)) * 100)}%` }} /></div>
          <p>Bạn có thể kết nối từng kênh độc lập. Một kênh lỗi không làm dừng toàn hệ thống.</p>
        </div>
        <div className="security-note"><span>✓</span><div><strong>Thông tin được bảo vệ</strong><p>TAHA AI không đưa mật khẩu hay token lên GitHub. Quyền truy cập được mã hóa trên máy chủ.</p></div></div>
      </aside>

      <section className="connections-workspace">
        <header className="connections-header">
          <div><span className="eyebrow">THIẾT LẬP HỆ THỐNG</span><h1>Kết nối các kênh của bạn</h1><p>Nguồn sản phẩm đi vào từ Google; nội dung và sản phẩm được xuất bản đến từng kênh theo quyền đã cấp.</p></div>
          <div className="connection-health"><i /><span>Hệ thống kết nối</span><strong>{connectedCount} hoạt động</strong></div>
        </header>

        {notice ? <div className={`connection-notice ${notice.tone}`} role="status"><span>{notice.tone === "success" ? "✓" : "!"}</span>{notice.text}<button type="button" onClick={() => setNotice(null)} aria-label="Đóng thông báo">×</button></div> : null}

        <div className="flow-strip" aria-label="Luồng dữ liệu">
          <div><span className="flow-icon source">G</span><strong>Google Drive + Sheet</strong><small>Nguồn ảnh & sản phẩm</small></div>
          <span className="flow-arrow">→</span>
          <div className="flow-core"><BrandMark /><strong>TAHA AI</strong><small>Xử lý · Duyệt · Lên lịch</small></div>
          <span className="flow-arrow">→</span>
          <div className="flow-destinations"><span>f</span><span>Z</span><span>S</span><span>T</span><strong>Đăng đa kênh</strong></div>
        </div>

        <section className="provider-section">
          <div className="provider-section-heading"><div><span className="eyebrow">TÀI KHOẢN & KÊNH</span><h2>Chọn kênh để kết nối</h2></div><p>Các nút chỉ hoạt động khi khóa ứng dụng tương ứng đã được nhập an toàn trên máy chủ.</p></div>
          {loading ? (
            <div className="connection-loading"><i /><span>Đang kiểm tra các kênh…</span></div>
          ) : (
            <div className="provider-grid">
              {providers.map((provider) => {
                const connected = provider.connections.some((connection) => connection.status === "connected");
                const isAssisted = provider.publishMode === "assisted";
                const workspaces = channelWorkspaces(provider.id);
                return (
                  <article className={`provider-card ${connected ? "ready" : ""}`} key={provider.id}>
                    <div className="provider-card-top"><span className="provider-mark" style={{ backgroundColor: provider.accent }}>{provider.mark}</span><span className={`provider-status ${connected ? "connected" : provider.configured ? "config-ready" : "pending"}`}><i />{statusLabel(provider)}</span></div>
                    <h3>{provider.name}</h3><p>{provider.description}</p>
                    <div className="capability-list">{provider.capabilities.map((item) => <span key={item}>✓ {item}</span>)}</div>
                    {provider.connections.length > 0 && <div className="connected-accounts">{provider.connections.map((connection) => <div key={connection.id}><span>{connection.displayName}</span><small>{connection.externalAccountId || modeLabel(provider.publishMode)}</small></div>)}</div>}
                    {!provider.configured && provider.missing.length > 0 && <details><summary>Còn thiếu {provider.missing.length} cấu hình</summary><ul>{provider.missing.map((item) => <li key={item}>{publicVariableName(item)}</li>)}</ul></details>}
                    {workspaces.length > 0 ? <div className="channel-shortcuts">{workspaces.map((workspace) => <Link href={workspace.href} key={workspace.href}>{workspace.label} <span>→</span></Link>)}</div> : null}
                    <div className="provider-card-footer">
                      <span>{modeLabel(provider.publishMode)}</span>
                      <div className="provider-actions">
                        {provider.setupUrl ? <a href={provider.setupUrl} target="_blank" rel="noreferrer">{provider.setupLabel || "Mở trang cấu hình"} ↗</a> : null}
                        {provider.id === "google" && connected ? <button className="secondary" type="button" disabled={busy === "google-sync"} onClick={() => void syncGoogle()}>{busy === "google-sync" ? "Đang đồng bộ…" : "Đồng bộ ngay"}</button> : null}
                        <button type="button" disabled={busy === provider.id} onClick={() => void connect(provider)}>{busy === provider.id ? "Đang mở…" : connected ? "Kết nối lại" : isAssisted ? "Bật trợ lý" : "Kết nối"}</button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="connection-guidance">
          <span>1</span><div><strong>Nhập khóa ứng dụng trên máy chủ</strong><p>Dùng bảng biến môi trường đi kèm repo; không gửi khóa bí mật qua tin nhắn.</p></div>
          <span>2</span><div><strong>Bấm Kết nối và cấp đúng quyền</strong><p>TAHA AI chuyển bạn đến trang chính thức của Google, Meta, Shopee hoặc TikTok.</p></div>
          <span>3</span><div><strong>Thử một sản phẩm trước</strong><p>Chỉ bật tự động hàng loạt sau khi bài và listing thử nghiệm đã chính xác.</p></div>
        </section>
      </section>
    </main>
  );
}
