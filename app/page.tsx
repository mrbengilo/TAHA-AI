import Link from "./SiteLink";
import { getDashboardSnapshot } from "../lib/dashboard";

const channelDefinitions = [
  { id: "facebook", name: "Facebook", tone: "blue", mark: "f" },
  { id: "zalo_personal", name: "Zalo cá nhân", tone: "cyan", mark: "Z" },
  { id: "shopee", name: "Shopee", tone: "orange", mark: "S" },
  { id: "tiktok_shop", name: "TikTok Shop", tone: "ink", mark: "T" },
] as const;

const providerNames: Record<string, string> = {
  facebook: "Facebook",
  zalo_personal: "Zalo cá nhân",
  shopee: "Shopee",
  tiktok_shop: "TikTok Shop",
  website: "Website",
};

export const dynamic = "force-dynamic";

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <b>TA</b>
    </span>
  );
}

export default async function Home() {
  const snapshot = await getDashboardSnapshot();
  const connected = new Set(snapshot.connectedProviders);
  const channels = channelDefinitions.map((channel) => ({
    ...channel,
    detail: connected.has(channel.id)
      ? channel.id === "zalo_personal" ? "Đăng có xác nhận" : "Đã kết nối"
      : "Chưa kết nối",
  }));
  const dateLabel = new Intl.DateTimeFormat("vi-VN", {
    day: "numeric",
    month: "long",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date()).toUpperCase();
  const formatTime = (value: number) => new Intl.DateTimeFormat("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date(value));
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <div><strong>TAHA</strong><span>AI Commerce</span></div>
        </div>

        <nav aria-label="Điều hướng chính">
          <a className="nav-item active" href="#tong-quan"><span className="nav-symbol">⌂</span>Tổng quan</a>
          <Link className="nav-item" href="/channels/google_sheets"><span className="nav-symbol">□</span>Sản phẩm<span className="nav-count">{snapshot.activeProducts}</span></Link>
          <Link className="nav-item" href="/channels/facebook?compose=1"><span className="nav-symbol">✦</span>Studio nội dung</Link>
          <Link className="nav-item" href="/channels?view=schedules"><span className="nav-symbol">◫</span>Lịch đăng<span className="nav-count warm">{snapshot.upcoming.length}</span></Link>
          <Link className="nav-item" href="/connections"><span className="nav-symbol">⌁</span>Kết nối kênh</Link>
          <Link className="nav-item" href="/channels?view=activity"><span className="nav-symbol">≡</span>Nhật ký</Link>
        </nav>

        <div className="sidebar-card">
          <span className="mini-label">TRỢ LÝ ZALO</span>
          <strong>{connected.has("zalo_personal") ? "Trợ lý đã được bật" : "Đăng an toàn có xác nhận"}</strong>
          <p>TAHA chuẩn bị caption và ảnh; bạn đăng bằng ứng dụng Zalo chính thức.</p>
          <Link href="/connections">Mở hướng dẫn</Link>
        </div>

        <div className="profile">
          <span className="avatar">TH</span>
          <div><strong>TAHA Store</strong><span>Quản trị viên</span></div>
          <Link className="profile-menu" href="/connections" aria-label="Mở cài đặt tài khoản">•••</Link>
        </div>
      </aside>

      <section className="workspace" id="tong-quan">
        <header className="topbar">
          <div><span className="eyebrow">TRUNG TÂM VẬN HÀNH</span><h1>Chào buổi sáng, TAHA.</h1></div>
          <div className="top-actions">
            <span className="live-status"><i /> {snapshot.attentionCount > 0 ? `${snapshot.attentionCount} mục cần chú ý` : "Hệ thống ổn định"}</span>
            <Link className="icon-button" href="/channels?view=attention" aria-label="Xem mục cần chú ý">♢<b>{snapshot.attentionCount}</b></Link>
            <Link className="primary-button" href="/channels/google_sheets"><span>＋</span> Thêm sản phẩm</Link>
          </div>
        </header>

        <section className="hero-grid">
          <article className="command-card">
            <div className="command-copy">
              <span className="eyebrow light">HÔM NAY · {dateLabel}</span>
              <h2>Nội dung của bạn<br />đang vận hành.</h2>
              <p>{snapshot.upcoming.length} bài chờ đăng, {snapshot.reviewCount} nội dung cần duyệt và {snapshot.activeProducts} sản phẩm đang hoạt động.</p>
              <div className="command-actions">
                <Link className="light-button" href="/channels?view=schedules">Xem lịch hôm nay <span>→</span></Link>
                <Link className="ghost-button" href="/channels?status=in_review">Duyệt nội dung</Link>
              </div>
            </div>
            <div className="orbit-visual" aria-hidden="true">
              <div className="orbit orbit-one" /><div className="orbit orbit-two" />
              <div className="core"><BrandMark /></div>
              <span className="satellite fb">f</span><span className="satellite zl">Z</span>
              <span className="satellite sh">S</span><span className="satellite tk">T</span>
            </div>
          </article>

          <article className="review-card">
            <div className="section-heading compact">
              <div><span className="eyebrow">CẦN XỬ LÝ</span><h2>{snapshot.reviewCount} nội dung chờ duyệt</h2></div>
              <Link className="review-all" href="/channels?status=in_review" aria-label="Xem tất cả nội dung chờ duyệt">→</Link>
            </div>
            {snapshot.review ? (
              <><div className="product-preview">
                <div className="shoe-placeholder"><span>{snapshot.review.product_name.slice(0, 2).toUpperCase()}</span><i /></div>
                <div className="preview-copy">
                  <span className="platform-tag">{providerNames[snapshot.review.target_provider]?.toUpperCase() || snapshot.review.target_provider.toUpperCase()}</span>
                  <strong>{snapshot.review.product_name}</strong>
                  <p>“{snapshot.review.body.slice(0, 72)}{snapshot.review.body.length > 72 ? "…" : ""}”</p>
                  <div className="preview-actions"><Link className="approve" href={`/channels/${snapshot.review.target_provider}?draft=${snapshot.review.id}`}>Mở để duyệt</Link><Link className="more" href={`/channels/${snapshot.review.target_provider}`} aria-label="Mở kho kênh">•••</Link></div>
                </div>
              </div><div className="review-progress"><i /><span>1 / {snapshot.reviewCount}</span></div></>
            ) : <div className="review-empty"><span>✓</span><strong>Không có nội dung chờ duyệt</strong><p>Nội dung mới sẽ xuất hiện ở đây sau khi được tạo.</p></div>}
          </article>
        </section>

        <section className="summary-row" aria-label="Tóm tắt hoạt động">
          <article><div className="metric-icon mint">↗</div><div><span>Bài đã đăng tháng này</span><strong>{snapshot.publishedThisMonth}</strong></div><small>Dữ liệu từ nhật ký xuất bản</small></article>
          <article><div className="metric-icon cream">✦</div><div><span>Ảnh AI đã tạo</span><strong>{snapshot.generatedImages}</strong></div><small>Chỉ tính ảnh đã xử lý xong</small></article>
          <article><div className="metric-icon violet">◫</div><div><span>Sản phẩm đang bán</span><strong>{snapshot.activeProducts}</strong></div><small>Đồng bộ từ kho trung tâm</small></article>
          <article><div className="metric-icon coral">!</div><div><span>Cần chú ý</span><strong>{snapshot.attentionCount}</strong></div><small>Lỗi kết nối hoặc xuất bản</small></article>
        </section>

        <section className="content-grid">
          <article className="schedule-card" id="lich-dang">
            <div className="section-heading">
              <div><span className="eyebrow">LỊCH ĐĂNG HÔM NAY</span><h2>Mọi kênh, một nhịp vận hành</h2></div>
              <Link className="text-button" href="/channels?view=schedules">Mở lịch đầy đủ →</Link>
            </div>
            <div className="queue-list">
              {snapshot.upcoming.length ? snapshot.upcoming.map((item) => (
                <div className="queue-item" key={`${item.scheduled_for}-${item.provider}`}>
                  <time>{formatTime(item.scheduled_for)}</time><i className="timeline-dot" />
                  <div className="queue-copy"><span>{providerNames[item.provider] || item.provider}</span><strong>{item.title || item.body || "Nội dung đã lên lịch"}</strong></div>
                  <span className={`state ${item.status === "awaiting_confirmation" ? "waiting" : "scheduled"}`}>{item.status === "awaiting_confirmation" ? "Chờ xác nhận" : "Đã lên lịch"}</span>
                  <Link className="queue-more" href={`/channels/${item.provider}`} aria-label={`Mở kênh của ${item.title || "bài đăng"}`}>•••</Link>
                </div>
              )) : <div className="queue-empty"><span>◫</span><strong>Chưa có bài nào trong lịch</strong><p>Kích hoạt một lịch sau khi nội dung đã được duyệt.</p></div>}
            </div>
          </article>

          <article className="channels-card" id="ket-noi">
            <div className="section-heading"><div><span className="eyebrow">KẾT NỐI KÊNH</span><h2>{snapshot.connectedProviders.length} kênh đã kết nối</h2></div><Link className="channel-settings-link" href="/connections" aria-label="Cài đặt kết nối">⚙</Link></div>
            <div className="channel-list">
              {channels.map((channel) => (
                <Link className="channel-row" href={`/channels/${channel.id}`} key={channel.name}>
                  <span className={`channel-mark ${channel.tone}`}>{channel.mark}</span>
                  <div><strong>{channel.name}</strong><span>{channel.detail}</span></div><i className={connected.has(channel.id) ? "connected" : "disconnected"} />
                </Link>
              ))}
            </div>
            <Link href="/connections" className="connect-button">＋ Kết nối kênh mới</Link>
          </article>
        </section>
      </section>
    </main>
  );
}
