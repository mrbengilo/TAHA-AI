import Link from "next/link";
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
          <a className="nav-item" href="#san-pham"><span className="nav-symbol">□</span>Sản phẩm<span className="nav-count">{snapshot.activeProducts}</span></a>
          <a className="nav-item" href="#noi-dung"><span className="nav-symbol">✦</span>Studio AI</a>
          <a className="nav-item" href="#lich-dang"><span className="nav-symbol">◫</span>Lịch đăng<span className="nav-count warm">{snapshot.upcoming.length}</span></a>
          <Link className="nav-item" href="/connections"><span className="nav-symbol">⌁</span>Kết nối kênh</Link>
          <a className="nav-item" href="#nhat-ky"><span className="nav-symbol">≡</span>Nhật ký</a>
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
          <button type="button" aria-label="Mở tùy chọn tài khoản">•••</button>
        </div>
      </aside>

      <section className="workspace" id="tong-quan">
        <header className="topbar">
          <div><span className="eyebrow">TRUNG TÂM VẬN HÀNH</span><h1>Chào buổi sáng, TAHA.</h1></div>
          <div className="top-actions">
            <span className="live-status"><i /> {snapshot.attentionCount > 0 ? `${snapshot.attentionCount} mục cần chú ý` : "Hệ thống ổn định"}</span>
            <button className="icon-button" type="button" aria-label="Thông báo">♢<b>3</b></button>
            <button className="primary-button" type="button"><span>＋</span> Thêm sản phẩm</button>
          </div>
        </header>

        <section className="hero-grid">
          <article className="command-card">
            <div className="command-copy">
              <span className="eyebrow light">HÔM NAY · {dateLabel}</span>
              <h2>Nội dung của bạn<br />đang vận hành.</h2>
              <p>{snapshot.upcoming.length} bài chờ đăng, {snapshot.reviewCount} nội dung cần duyệt và {snapshot.activeProducts} sản phẩm đang hoạt động.</p>
              <div className="command-actions">
                <button type="button" className="light-button">Xem lịch hôm nay <span>→</span></button>
                <button type="button" className="ghost-button">Duyệt nội dung</button>
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
              <button type="button" aria-label="Xem tất cả">→</button>
            </div>
            {snapshot.review ? (
              <><div className="product-preview">
                <div className="shoe-placeholder"><span>{snapshot.review.product_name.slice(0, 2).toUpperCase()}</span><i /></div>
                <div className="preview-copy">
                  <span className="platform-tag">{providerNames[snapshot.review.target_provider]?.toUpperCase() || snapshot.review.target_provider.toUpperCase()}</span>
                  <strong>{snapshot.review.product_name}</strong>
                  <p>“{snapshot.review.body.slice(0, 72)}{snapshot.review.body.length > 72 ? "…" : ""}”</p>
                  <div className="preview-actions"><button type="button" className="approve">Duyệt</button><button type="button" className="more" aria-label="Tùy chọn">•••</button></div>
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
              <button type="button" className="text-button">Mở lịch đầy đủ →</button>
            </div>
            <div className="queue-list">
              {snapshot.upcoming.length ? snapshot.upcoming.map((item) => (
                <div className="queue-item" key={`${item.scheduled_for}-${item.provider}`}>
                  <time>{formatTime(item.scheduled_for)}</time><i className="timeline-dot" />
                  <div className="queue-copy"><span>{providerNames[item.provider] || item.provider}</span><strong>{item.title || item.body || "Nội dung đã lên lịch"}</strong></div>
                  <span className={`state ${item.status === "awaiting_confirmation" ? "waiting" : "scheduled"}`}>{item.status === "awaiting_confirmation" ? "Chờ xác nhận" : "Đã lên lịch"}</span>
                  <button type="button" aria-label={`Tùy chọn ${item.title || "bài đăng"}`}>•••</button>
                </div>
              )) : <div className="queue-empty"><span>◫</span><strong>Chưa có bài nào trong lịch</strong><p>Kích hoạt một lịch sau khi nội dung đã được duyệt.</p></div>}
            </div>
          </article>

          <article className="channels-card" id="ket-noi">
            <div className="section-heading"><div><span className="eyebrow">KẾT NỐI KÊNH</span><h2>{snapshot.connectedProviders.length} kênh đã kết nối</h2></div><Link className="channel-settings-link" href="/connections" aria-label="Cài đặt kết nối">⚙</Link></div>
            <div className="channel-list">
              {channels.map((channel) => (
                <div className="channel-row" key={channel.name}>
                  <span className={`channel-mark ${channel.tone}`}>{channel.mark}</span>
                  <div><strong>{channel.name}</strong><span>{channel.detail}</span></div><i className={connected.has(channel.id) ? "connected" : "disconnected"} />
                </div>
              ))}
            </div>
            <Link href="/connections" className="connect-button">＋ Kết nối kênh mới</Link>
          </article>
        </section>
      </section>
    </main>
  );
}
