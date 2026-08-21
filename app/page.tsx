import type { CSSProperties, ReactNode } from "react";
import Link from "./SiteLink";
import "./dashboard/dashboard.css";
import { getDashboardSnapshot } from "../lib/dashboard";

const channelDefinitions = [
  { id: "google_drive", provider: "google", name: "Google Drive", mark: "△", tone: "drive" },
  { id: "google_sheets", provider: "google", name: "Google Sheets", mark: "▦", tone: "sheets" },
  { id: "facebook", provider: "facebook", name: "Facebook", mark: "f", tone: "facebook" },
  { id: "zalo_personal", provider: "zalo_personal", name: "Zalo cá nhân", mark: "Z", tone: "zalo" },
  { id: "tiktok_shop", provider: "tiktok_shop", name: "TikTok Shop", mark: "♪", tone: "tiktok" },
  { id: "shopee", provider: "shopee", name: "Shopee Seller", mark: "S", tone: "shopee" },
  { id: "website", provider: "website", name: "Website", mark: "◎", tone: "website" },
] as const;

const providerNames: Record<string, string> = {
  google: "Google", facebook: "Facebook", zalo_personal: "Zalo", shopee: "Shopee", tiktok_shop: "TikTok Shop", website: "Website",
};

const jobStatus: Record<string, string> = {
  published: "Thành công", queued: "Đang chờ", publishing: "Đang đăng", retry_wait: "Chờ thử lại",
  awaiting_confirmation: "Chờ xác nhận", blocked: "Cần xử lý", failed: "Thất bại", cancelled: "Đã hủy",
};

const dashboardDateFormatter = new Intl.DateTimeFormat("vi-VN", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Asia/Ho_Chi_Minh",
});
const dashboardTimeFormatter = new Intl.DateTimeFormat("vi-VN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Ho_Chi_Minh",
});
const dashboardDayFormatter = new Intl.DateTimeFormat("vi-VN", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Asia/Ho_Chi_Minh",
});
const weekWindowMs = 6 * 24 * 60 * 60 * 1000;

export const dynamic = "force-dynamic";

function RobotMark() {
  return <span className="dash-robot" aria-hidden="true"><i /><b>TA</b></span>;
}

function NavIcon({ children }: { children: ReactNode }) {
  return <span className="dash-nav-icon" aria-hidden="true">{children}</span>;
}

function ProviderMark({ provider }: { provider: string }) {
  return <span className={`dash-mini-logo ${provider}`} aria-hidden="true">{provider === "facebook" ? "f" : provider === "zalo_personal" ? "Z" : provider === "shopee" ? "S" : provider === "tiktok_shop" ? "♪" : "◎"}</span>;
}

export default async function Home() {
  const snapshot = await getDashboardSnapshot();
  const connected = new Set(snapshot.connectedProviders);
  const connectionByProvider = new Map(snapshot.connections.map((connection) => [connection.provider, connection]));
  const now = new Date();
  const start = new Date(now.getTime() - weekWindowMs);
  const connectedChannelCount = channelDefinitions.filter((item) => connected.has(item.provider)).length;
  const connectionProgress = Math.round((connectedChannelCount / channelDefinitions.length) * 100);
  const recordedItemCount = snapshot.publishedThisMonth
    + snapshot.readyMedia
    + snapshot.activeProducts
    + snapshot.activeScheduleCount
    + snapshot.attentionCount
    + snapshot.reviewCount
    + snapshot.connections.length
    + snapshot.recentActivity.length
    + snapshot.upcoming.length;
  const metrics = [
    { label: "Bài đã đăng", value: snapshot.publishedThisMonth, detail: snapshot.publishedThisMonth ? "Đã ghi nhận trong tháng này" : "Chưa ghi nhận bài trong tháng", icon: "➤", tone: "violet" },
    { label: "Sản phẩm", value: snapshot.activeProducts, detail: snapshot.activeProducts ? "Sản phẩm đang hoạt động" : "Chưa có sản phẩm hoạt động", icon: "▣", tone: "green" },
    { label: "Ảnh & video", value: snapshot.readyMedia, detail: snapshot.readyMedia ? `${snapshot.generatedImages} ảnh do AI tạo` : "Chưa có media sẵn sàng", icon: "▧", tone: "amber" },
    { label: "Lịch tự động", value: snapshot.activeScheduleCount, detail: snapshot.activeScheduleCount ? "Lịch đang hoạt động" : "Chưa có lịch hoạt động", icon: "◷", tone: "pink" },
    { label: "Cần xử lý", value: snapshot.attentionCount + snapshot.reviewCount, detail: snapshot.attentionCount || snapshot.reviewCount ? `${snapshot.attentionCount} lỗi · ${snapshot.reviewCount} chờ duyệt` : "0 mục được hệ thống ghi nhận", icon: "✦", tone: "blue" },
  ];

  return (
    <div className="dash-shell">
      <aside className="dash-sidebar">
        <Link className="dash-brand" href="/" aria-label="TAHA AI - Tổng quan"><RobotMark /><strong>TAHA-AI</strong></Link>
        <nav className="dash-nav" aria-label="Điều hướng chính">
          <Link className="is-active" href="/" aria-current="page"><NavIcon>⌂</NavIcon>Tổng quan</Link>
          <Link href="/channels"><NavIcon>⌁</NavIcon>Kênh tích hợp</Link>
          <Link href="/automation"><NavIcon>✥</NavIcon>AI Automation</Link>
          <Link href="/channels?view=schedules"><NavIcon>▣</NavIcon>Lịch đăng bài</Link>
          <Link href="/channels/google_sheets"><NavIcon>▢</NavIcon>Sản phẩm</Link>
          <Link href="/channels/google_drive"><NavIcon>▧</NavIcon>Nội dung & Media</Link>
          <Link href="/channels?status=in_review"><NavIcon>◌</NavIcon>Chiến dịch</Link>
          <Link href="/channels?view=activity"><NavIcon>▥</NavIcon>Báo cáo & Nhật ký</Link>
          <Link href="/connections"><NavIcon>⚙</NavIcon>Cài đặt hệ thống</Link>
          <Link href="/connections/guide"><NavIcon>?</NavIcon>Hướng dẫn kết nối</Link>
        </nav>
        <div className="dash-plan-card">
          <span>HỆ THỐNG TAHA AI</span><strong>{connectedChannelCount}/{channelDefinitions.length} kênh sẵn sàng</strong>
          <p>Google, Facebook và các kênh bán hàng được quản lý tập trung.</p>
          <div><i style={{ width: `${connectionProgress}%` }} /></div><Link href="/connections">Quản lý kết nối →</Link>
        </div>
      </aside>

      <main className="dash-main">
        <header className="dash-header">
          <span className="dash-menu" aria-hidden="true">☰</span>
          <div className="dash-header-actions">
            <Link className="dash-create" href="/channels/facebook?compose=1"><b aria-hidden="true">＋</b><span>Tạo mới</span></Link>
            <Link className="dash-bell" href="/channels?view=attention" aria-label={`${snapshot.attentionCount} mục cần chú ý`}>♢{snapshot.attentionCount > 0 ? <b>{snapshot.attentionCount}</b> : null}</Link>
            <Link className="dash-user" href="/connections"><span>T</span><span><strong>TaHa Team</strong><small>Quản trị viên</small></span><i>⌄</i></Link>
          </div>
        </header>

        <div className="dash-content">
          <div className="dash-welcome">
            <div><h1>Xin chào, TaHa Team! <span>👋</span></h1><p>{recordedItemCount ? "Đây là dữ liệu vận hành hiện có của hệ thống TAHA-AI." : "Hệ thống chưa ghi nhận dữ liệu vận hành; các chỉ số bên dưới đang ở mức 0."}</p></div>
            <div className="dash-date" aria-label="Khoảng thời gian hiển thị"><time dateTime={start.toISOString()}>{dashboardDateFormatter.format(start)}</time><span aria-hidden="true">–</span><time dateTime={now.toISOString()}>{dashboardDateFormatter.format(now)}</time><b aria-hidden="true">▣</b></div>
          </div>

          <section className="dash-metrics" aria-label="Chỉ số vận hành">
            {metrics.map((metric) => <article key={metric.label}>
              <span className={`dash-metric-icon ${metric.tone}`} aria-hidden="true">{metric.icon}</span>
              <div><span>{metric.label}</span><strong>{metric.value.toLocaleString("vi-VN")}</strong></div><small>{metric.detail}</small>
            </article>)}
          </section>

          <section className="dash-panel dash-integrations" aria-labelledby="integration-title">
            <div className="dash-panel-heading"><h2 id="integration-title">Kênh tích hợp</h2><Link href="/connections">Quản lý kênh tích hợp</Link></div>
            <div className="dash-channel-grid">
              {channelDefinitions.map((channel) => {
                const isConnected = connected.has(channel.provider);
                const account = connectionByProvider.get(channel.provider);
                const detail = isConnected
                  ? account?.display_name || account?.external_account_id || "Tài khoản đã kết nối"
                  : "Chưa kết nối tài khoản";
                return <Link className="dash-channel-card" href={`/channels/${channel.id}`} key={channel.id}>
                  <span className={`dash-channel-logo ${channel.tone}`} aria-hidden="true">{channel.mark}</span>
                  <div><strong>{channel.name}</strong><b className={isConnected ? "is-connected" : "is-pending"}>{isConnected ? "Đã kết nối" : "Chờ kết nối"}</b><small>{detail}</small></div>
                </Link>;
              })}
              <Link className="dash-channel-card dash-add-channel" href="/connections"><span aria-hidden="true">＋</span><strong>Kết nối kênh mới</strong></Link>
            </div>
          </section>

          <section className="dash-lower-grid">
            <article className="dash-panel dash-automation">
              <div className="dash-panel-heading"><h2>AI Automation đang hoạt động</h2><Link href="/channels?view=schedules">Xem tất cả</Link></div>
              <div className="dash-list">
                {snapshot.activeSchedules.length ? snapshot.activeSchedules.map((item) => <div className="dash-list-row" key={item.id}>
                  <ProviderMark provider={item.provider} /><div><strong>{item.title || `Tự động đăng ${providerNames[item.provider] || item.provider}`}</strong><small>{item.execution_mode === "assisted" ? "Đăng có xác nhận" : "Tự động qua API"}</small></div>
                  <span className="dash-running"><i />Đang chạy<small>{item.local_time || (item.next_run_at ? dashboardTimeFormatter.format(item.next_run_at) : "Theo lịch")}</small></span>
                </div>) : <div className="dash-empty"><span aria-hidden="true">✥</span><strong>Chưa ghi nhận lịch tự động</strong><p>Duyệt nội dung rồi kích hoạt lịch đăng để bắt đầu.</p><Link href="/channels?view=schedules">Tạo lịch đầu tiên</Link></div>}
              </div>
            </article>

            <article className="dash-panel dash-upcoming">
              <div className="dash-panel-heading"><h2>Lịch đăng bài sắp tới</h2><Link href="/channels?view=schedules">Xem lịch</Link></div>
              <div className="dash-list">
                {snapshot.upcoming.length ? snapshot.upcoming.map((item, index) => <div className="dash-schedule-row" key={`${item.scheduled_for}-${item.provider}-${index}`}>
                  <time><strong>{dashboardTimeFormatter.format(item.scheduled_for)}</strong><small>{dashboardDayFormatter.format(item.scheduled_for)}</small></time><ProviderMark provider={item.provider} />
                  <div><strong>{item.title || item.body || "Nội dung đã lên lịch"}</strong><small>{providerNames[item.provider] || item.provider}</small></div>
                  <b>{item.status === "awaiting_confirmation" ? "Chờ xác nhận" : "Sắp tới"}</b>
                </div>) : <div className="dash-empty"><span aria-hidden="true">◷</span><strong>Chưa ghi nhận bài sắp đăng</strong><p>Các bài đã lên lịch sẽ xuất hiện tại đây.</p><Link href="/channels">Mở kho nội dung</Link></div>}
              </div>
            </article>

            <article className="dash-panel dash-health">
              <div className="dash-panel-heading"><h2>Sức khỏe hệ thống</h2><Link href="/connections">Chi tiết</Link></div>
              <div className="dash-ring" role="img" aria-label={`${connectedChannelCount} trên ${channelDefinitions.length} kênh sẵn sàng, tương đương ${connectionProgress}%`} style={{ "--progress": `${connectionProgress * 3.6}deg` } as CSSProperties}><div><span>Kênh sẵn sàng</span><strong>{connectedChannelCount}/{channelDefinitions.length}</strong><b>{connectionProgress}%</b></div></div>
              <div className="dash-health-legend"><span><i className="ok" />Đã kết nối <b>{connectedChannelCount}</b></span><span><i />Chờ cấu hình <b>{channelDefinitions.length - connectedChannelCount}</b></span><span><i className="warn" />Cần xử lý <b>{snapshot.attentionCount}</b></span></div>
            </article>
          </section>

          <section className="dash-panel dash-activity">
            <div className="dash-panel-heading"><h2>Hoạt động gần đây</h2><Link href="/channels?view=activity">Xem nhật ký</Link></div>
            {snapshot.recentActivity.length ? <div className="dash-activity-grid">{snapshot.recentActivity.map((item) => <Link href={`/channels/${item.provider}`} key={item.id}>
              <ProviderMark provider={item.provider} /><div><strong>{item.title || `${providerNames[item.provider] || item.provider} · ${jobStatus[item.status] || item.status}`}</strong><small>{dashboardTimeFormatter.format(item.updated_at)} · {dashboardDayFormatter.format(item.updated_at)}</small></div>
              <b className={`dash-job-${item.status}`}>{jobStatus[item.status] || item.status}</b>
            </Link>)}</div> : <div className="dash-empty dash-empty-compact"><span aria-hidden="true">≡</span><strong>Chưa ghi nhận hoạt động xuất bản</strong><p>Nhật ký sẽ tự cập nhật sau lần đăng đầu tiên.</p></div>}
          </section>
        </div>
      </main>
    </div>
  );
}
