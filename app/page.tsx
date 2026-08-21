import Link from "./SiteLink";
import { getDashboardSnapshot } from "../lib/dashboard";

const channelDefinitions = [
  { id: "google_drive", provider: "google", name: "Google Drive", mark: "△", tone: "drive", fallback: "Kho hình ảnh nguồn" },
  { id: "google_sheets", provider: "google", name: "Google Sheets", mark: "▦", tone: "sheets", fallback: "Dữ liệu sản phẩm" },
  { id: "facebook", provider: "facebook", name: "Facebook", mark: "f", tone: "facebook", fallback: "Facebook Page" },
  { id: "zalo_personal", provider: "zalo_personal", name: "Zalo cá nhân", mark: "Z", tone: "zalo", fallback: "Đăng có xác nhận" },
  { id: "tiktok_shop", provider: "tiktok_shop", name: "TikTok Shop", mark: "♪", tone: "tiktok", fallback: "Kênh bán hàng" },
  { id: "shopee", provider: "shopee", name: "Shopee Seller", mark: "S", tone: "shopee", fallback: "Kênh bán hàng" },
  { id: "website", provider: "website", name: "Website", mark: "◎", tone: "website", fallback: "tahashoes.vn" },
] as const;

const providerNames: Record<string, string> = {
  google: "Google", facebook: "Facebook", zalo_personal: "Zalo", shopee: "Shopee", tiktok_shop: "TikTok Shop", website: "Website",
};

const jobStatus: Record<string, string> = {
  published: "Thành công", queued: "Đang chờ", publishing: "Đang đăng", retry_wait: "Chờ thử lại",
  awaiting_confirmation: "Chờ xác nhận", blocked: "Cần xử lý", failed: "Thất bại", cancelled: "Đã hủy",
};

export const dynamic = "force-dynamic";

function RobotMark() {
  return <span className="dash-robot" aria-hidden="true"><i /><b>TA</b></span>;
}

function NavIcon({ children }: { children: React.ReactNode }) {
  return <span className="dash-nav-icon" aria-hidden="true">{children}</span>;
}

function ProviderMark({ provider }: { provider: string }) {
  return <span className={`dash-mini-logo ${provider}`}>{provider === "facebook" ? "f" : provider === "zalo_personal" ? "Z" : provider === "shopee" ? "S" : provider === "tiktok_shop" ? "♪" : "◎"}</span>;
}

export default async function Home() {
  const snapshot = await getDashboardSnapshot();
  const connected = new Set(snapshot.connectedProviders);
  const now = new Date();
  const start = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
  const dateFormatter = new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" });
  const timeFormatter = new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Ho_Chi_Minh" });
  const dayFormatter = new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", timeZone: "Asia/Ho_Chi_Minh" });
  const connectedChannelCount = channelDefinitions.filter((item) => connected.has(item.provider)).length;
  const connectionProgress = Math.round((connectedChannelCount / channelDefinitions.length) * 100);
  const connectionFor = (provider: string) => snapshot.connections.find((item) => item.provider === provider);
  const metrics = [
    { label: "Bài đã đăng", value: snapshot.publishedThisMonth, detail: "trong tháng này", icon: "➤", tone: "violet" },
    { label: "Sản phẩm", value: snapshot.activeProducts, detail: "đang hoạt động", icon: "▣", tone: "green" },
    { label: "Ảnh & video", value: snapshot.readyMedia, detail: `${snapshot.generatedImages} ảnh do AI tạo`, icon: "▧", tone: "amber" },
    { label: "Lịch tự động", value: snapshot.activeScheduleCount, detail: "đang chạy", icon: "◷", tone: "pink" },
    { label: "Cần xử lý", value: snapshot.attentionCount + snapshot.reviewCount, detail: snapshot.attentionCount ? "có lỗi cần kiểm tra" : "nội dung chờ duyệt", icon: "✦", tone: "blue" },
  ];

  return (
    <main className="dash-shell">
      <aside className="dash-sidebar">
        <Link className="dash-brand" href="/" aria-label="TAHA AI - Tổng quan"><RobotMark /><strong>TAHA-AI</strong></Link>
        <nav className="dash-nav" aria-label="Điều hướng chính">
          <Link className="is-active" href="/"><NavIcon>⌂</NavIcon>Tổng quan</Link>
          <Link href="/channels"><NavIcon>⌁</NavIcon>Kênh tích hợp</Link>
          <Link href="/channels?view=schedules"><NavIcon>✥</NavIcon>AI Automation</Link>
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

      <section className="dash-main">
        <header className="dash-header">
          <span className="dash-menu" aria-hidden="true">☰</span>
          <div className="dash-header-actions">
            <Link className="dash-create" href="/channels/facebook?compose=1"><b>＋</b>Tạo mới</Link>
            <Link className="dash-bell" href="/channels?view=attention" aria-label={`${snapshot.attentionCount} mục cần chú ý`}>♢{snapshot.attentionCount > 0 ? <b>{snapshot.attentionCount}</b> : null}</Link>
            <Link className="dash-user" href="/connections"><span>T</span><span><strong>TaHa Team</strong><small>Quản trị viên</small></span><i>⌄</i></Link>
          </div>
        </header>

        <div className="dash-content">
          <div className="dash-welcome">
            <div><h1>Xin chào, TaHa Team! <span>👋</span></h1><p>Đây là tổng quan vận hành TAHA-AI theo dữ liệu thời gian thực.</p></div>
            <div className="dash-date"><span>{dateFormatter.format(start)} - {dateFormatter.format(now)}</span><b>▣</b></div>
          </div>

          <section className="dash-metrics" aria-label="Chỉ số vận hành">
            {metrics.map((metric) => <article key={metric.label}>
              <span className={`dash-metric-icon ${metric.tone}`}>{metric.icon}</span>
              <div><span>{metric.label}</span><strong>{metric.value.toLocaleString("vi-VN")}</strong></div><small>{metric.detail}</small>
            </article>)}
          </section>

          <section className="dash-panel dash-integrations" aria-labelledby="integration-title">
            <div className="dash-panel-heading"><h2 id="integration-title">Kênh tích hợp</h2><Link href="/connections">Quản lý kênh tích hợp</Link></div>
            <div className="dash-channel-grid">
              {channelDefinitions.map((channel) => {
                const isConnected = connected.has(channel.provider);
                const account = connectionFor(channel.provider);
                const detail = account?.display_name || account?.external_account_id || channel.fallback;
                return <Link className="dash-channel-card" href={`/channels/${channel.id}`} key={channel.id}>
                  <span className={`dash-channel-logo ${channel.tone}`}>{channel.mark}</span>
                  <div><strong>{channel.name}</strong><b className={isConnected ? "is-connected" : "is-pending"}>{isConnected ? "Đã kết nối" : "Chờ kết nối"}</b><small>{detail}</small></div>
                </Link>;
              })}
              <Link className="dash-channel-card dash-add-channel" href="/connections"><span>＋</span><strong>Kết nối kênh mới</strong></Link>
            </div>
          </section>

          <section className="dash-lower-grid">
            <article className="dash-panel dash-automation">
              <div className="dash-panel-heading"><h2>AI Automation đang hoạt động</h2><Link href="/channels?view=schedules">Xem tất cả</Link></div>
              <div className="dash-list">
                {snapshot.activeSchedules.length ? snapshot.activeSchedules.map((item) => <div className="dash-list-row" key={item.id}>
                  <ProviderMark provider={item.provider} /><div><strong>{item.title || `Tự động đăng ${providerNames[item.provider] || item.provider}`}</strong><small>{item.execution_mode === "assisted" ? "Đăng có xác nhận" : "Tự động qua API"}</small></div>
                  <span className="dash-running"><i />Đang chạy<small>{item.local_time || (item.next_run_at ? timeFormatter.format(item.next_run_at) : "Theo lịch")}</small></span>
                </div>) : <div className="dash-empty"><span>✥</span><strong>Chưa có lịch tự động</strong><p>Duyệt nội dung rồi kích hoạt lịch đăng để bắt đầu.</p><Link href="/channels?view=schedules">Tạo lịch đầu tiên</Link></div>}
              </div>
            </article>

            <article className="dash-panel dash-upcoming">
              <div className="dash-panel-heading"><h2>Lịch đăng bài sắp tới</h2><Link href="/channels?view=schedules">Xem lịch</Link></div>
              <div className="dash-list">
                {snapshot.upcoming.length ? snapshot.upcoming.map((item, index) => <div className="dash-schedule-row" key={`${item.scheduled_for}-${item.provider}-${index}`}>
                  <time><strong>{timeFormatter.format(item.scheduled_for)}</strong><small>{dayFormatter.format(item.scheduled_for)}</small></time><ProviderMark provider={item.provider} />
                  <div><strong>{item.title || item.body || "Nội dung đã lên lịch"}</strong><small>{providerNames[item.provider] || item.provider}</small></div>
                  <b>{item.status === "awaiting_confirmation" ? "Chờ xác nhận" : "Sắp tới"}</b>
                </div>) : <div className="dash-empty"><span>◷</span><strong>Lịch đang trống</strong><p>Các bài đã lên lịch sẽ xuất hiện tại đây.</p><Link href="/channels">Mở kho nội dung</Link></div>}
              </div>
            </article>

            <article className="dash-panel dash-health">
              <div className="dash-panel-heading"><h2>Sức khỏe hệ thống</h2><Link href="/connections">Chi tiết</Link></div>
              <div className="dash-ring" style={{ "--progress": `${connectionProgress * 3.6}deg` } as React.CSSProperties}><div><span>Kênh sẵn sàng</span><strong>{connectedChannelCount}/{channelDefinitions.length}</strong><b>{connectionProgress}%</b></div></div>
              <div className="dash-health-legend"><span><i className="ok" />Đã kết nối <b>{connectedChannelCount}</b></span><span><i />Chờ cấu hình <b>{channelDefinitions.length - connectedChannelCount}</b></span><span><i className="warn" />Cần xử lý <b>{snapshot.attentionCount}</b></span></div>
            </article>
          </section>

          <section className="dash-panel dash-activity">
            <div className="dash-panel-heading"><h2>Hoạt động gần đây</h2><Link href="/channels?view=activity">Xem nhật ký</Link></div>
            {snapshot.recentActivity.length ? <div className="dash-activity-grid">{snapshot.recentActivity.map((item) => <Link href={`/channels/${item.provider}`} key={item.id}>
              <ProviderMark provider={item.provider} /><div><strong>{item.title || `${providerNames[item.provider] || item.provider} · ${jobStatus[item.status] || item.status}`}</strong><small>{timeFormatter.format(item.updated_at)} · {dayFormatter.format(item.updated_at)}</small></div>
              <b className={`dash-job-${item.status}`}>{jobStatus[item.status] || item.status}</b>
            </Link>)}</div> : <div className="dash-empty dash-empty-compact"><span>≡</span><strong>Chưa có hoạt động xuất bản</strong><p>Nhật ký sẽ tự cập nhật sau lần đăng đầu tiên.</p></div>}
          </section>
        </div>
      </section>
    </main>
  );
}
