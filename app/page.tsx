import Link from "./SiteLink";
import { AppIcon } from "./ui/AppIcon";
import { AppShell } from "./ui/AppShell";
import { getDashboardSnapshot } from "../lib/dashboard";

const providerNames: Record<string, string> = {
  google: "Google",
  facebook: "Facebook",
  zalo_personal: "Zalo cá nhân",
  shopee: "Shopee",
  tiktok_shop: "TikTok Shop",
  website: "Website",
};

const providerMarks: Record<string, string> = {
  google: "G",
  facebook: "f",
  zalo_personal: "Z",
  shopee: "S",
  tiktok_shop: "T",
  website: "W",
};

const jobLabels: Record<string, string> = {
  published: "Đã đăng",
  queued: "Đang chờ",
  publishing: "Đang đăng",
  retry_wait: "Chờ thử lại",
  awaiting_confirmation: "Chờ xác nhận",
  blocked: "Cần xử lý",
  failed: "Thất bại",
  cancelled: "Đã hủy",
};

const dateFormatter = new Intl.DateTimeFormat("vi-VN", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Asia/Ho_Chi_Minh",
});

const shortDateFormatter = new Intl.DateTimeFormat("vi-VN", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Asia/Ho_Chi_Minh",
});

const timeFormatter = new Intl.DateTimeFormat("vi-VN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Ho_Chi_Minh",
});

export const dynamic = "force-dynamic";

function ProviderBadge({ provider }: { provider: string }) {
  return <span className={`ui-provider-badge ${provider}`} aria-hidden="true">{providerMarks[provider] || provider.slice(0, 1).toUpperCase()}</span>;
}

function Status({ status }: { status: string }) {
  const tone = status === "published"
    ? "is-success"
    : status === "failed" || status === "blocked"
      ? "is-danger"
      : status === "retry_wait" || status === "awaiting_confirmation"
        ? "is-warning"
        : "is-info";
  return <span className={`ui-status ${tone}`}>{jobLabels[status] || status}</span>;
}

export default async function Home() {
  const snapshot = await getDashboardSnapshot();
  const connected = new Set(snapshot.connectedProviders);
  const attentionTotal = snapshot.attentionCount + snapshot.reviewCount;
  const sourcesReady = connected.has("google");
  const distributionProviders = ["facebook", "zalo_personal", "website", "shopee", "tiktok_shop"];
  const distributionReady = distributionProviders.filter((provider) => connected.has(provider)).length;

  return (
    <AppShell
      active="overview"
      contextTitle="Tổng quan vận hành"
      noticeCount={attentionTotal}
      headerActions={(
        <Link className="ui-button is-primary" href="/products">
          <AppIcon name="plus" size={17} /> Mở sản phẩm
        </Link>
      )}
    >
      <section className="ui-page-header">
        <div className="ui-page-header-copy">
          <span className="ui-eyebrow">TRUNG TÂM ĐIỀU HÀNH</span>
          <h1>Vận hành sản phẩm và nội dung đa kênh</h1>
          <p>Dữ liệu từ Google Sheets và hình ảnh trong thư mục Drive theo SKU được tập trung thành một quy trình tạo nội dung, lên lịch và xuất bản rõ ràng.</p>
        </div>
        <div className="ui-page-actions">
          <Link className="ui-button" href="/connections"><AppIcon name="sync" size={17} /> Đồng bộ dữ liệu</Link>
          <Link className="ui-button" href="/automation"><AppIcon name="automation" size={17} /> Tạo nội dung</Link>
          <Link className="ui-button is-primary" href="/products"><AppIcon name="publish" size={17} /> Đăng sản phẩm</Link>
        </div>
      </section>

      <section className="ui-kpi-grid" aria-label="Chỉ số vận hành">
        <article className="ui-kpi">
          <span className="ui-kpi-icon"><AppIcon name="products" size={21} /></span>
          <span>Sản phẩm đang hoạt động</span>
          <strong>{snapshot.activeProducts.toLocaleString("vi-VN")}</strong>
          <small>Được đồng bộ từ Google Sheets và sẵn sàng kiểm tra theo SKU.</small>
        </article>
        <article className="ui-kpi is-success">
          <span className="ui-kpi-icon"><AppIcon name="publish" size={21} /></span>
          <span>Đã đăng trong tháng</span>
          <strong>{snapshot.publishedThisMonth.toLocaleString("vi-VN")}</strong>
          <small>Bài viết hoặc tác vụ xuất bản đã được nền tảng xác nhận.</small>
        </article>
        <article className="ui-kpi">
          <span className="ui-kpi-icon"><AppIcon name="calendar" size={21} /></span>
          <span>Lịch đang hoạt động</span>
          <strong>{snapshot.activeScheduleCount.toLocaleString("vi-VN")}</strong>
          <small>Các lịch social automation đang được hệ thống theo dõi.</small>
        </article>
        <article className={attentionTotal > 0 ? "ui-kpi is-danger" : "ui-kpi is-success"}>
          <span className="ui-kpi-icon"><AppIcon name={attentionTotal > 0 ? "alert" : "check"} size={21} /></span>
          <span>Cần xử lý</span>
          <strong>{attentionTotal.toLocaleString("vi-VN")}</strong>
          <small>{snapshot.attentionCount} lỗi vận hành · {snapshot.reviewCount} nội dung chờ duyệt.</small>
        </article>
      </section>

      <section className="ui-dashboard-grid">
        <div className="ui-stack">
          <article className="ui-panel">
            <header className="ui-panel-header">
              <div><h2>Cần xử lý</h2><p>Ưu tiên các mục ảnh hưởng trực tiếp đến vận hành.</p></div>
              <Link href="/activity">Mở nhật ký <AppIcon name="arrow-right" size={15} /></Link>
            </header>
            <div className="ui-list">
              <div className="ui-list-row">
                <span className="ui-list-icon"><AppIcon name="connections" size={19} /></span>
                <div><strong>Nguồn Google</strong><p>{sourcesReady ? "Google đã kết nối; có thể kiểm tra lần đồng bộ gần nhất." : "Chưa có kết nối Google hoạt động."}</p></div>
                <span className={`ui-status ${sourcesReady ? "is-success" : "is-danger"}`}>{sourcesReady ? "Sẵn sàng" : "Cần kết nối"}</span>
              </div>
              <div className="ui-list-row">
                <span className="ui-list-icon"><AppIcon name="alert" size={19} /></span>
                <div><strong>Job và kết nối có lỗi</strong><p>Nhật ký thất bại hoặc kết nối hết hạn cần được kiểm tra.</p></div>
                <span className={`ui-status ${snapshot.attentionCount ? "is-danger" : "is-success"}`}>{snapshot.attentionCount} mục</span>
              </div>
              <div className="ui-list-row">
                <span className="ui-list-icon"><AppIcon name="content" size={19} /></span>
                <div><strong>Nội dung chờ duyệt</strong><p>Chỉ nội dung đã duyệt mới được đưa vào lịch hoặc xuất bản.</p></div>
                <span className={`ui-status ${snapshot.reviewCount ? "is-warning" : "is-success"}`}>{snapshot.reviewCount} mục</span>
              </div>
            </div>
          </article>

          <article className="ui-panel">
            <header className="ui-panel-header">
              <div><h2>Nguồn dữ liệu</h2><p>Google Sheets giữ dữ liệu, Drive giữ ảnh theo thư mục SKU.</p></div>
              <Link href="/connections">Quản lý <AppIcon name="arrow-right" size={15} /></Link>
            </header>
            <div className="ui-list">
              <div className="ui-list-row">
                <ProviderBadge provider="google" />
                <div><strong>Google Sheets</strong><p>{snapshot.activeProducts} sản phẩm hoạt động</p></div>
                <span className={`ui-status ${sourcesReady ? "is-success" : "is-danger"}`}>{sourcesReady ? "Đã kết nối" : "Chưa kết nối"}</span>
              </div>
              <div className="ui-list-row">
                <span className="ui-list-icon"><AppIcon name="image" size={19} /></span>
                <div><strong>Google Drive & R2</strong><p>{snapshot.readyMedia} media sẵn sàng · {snapshot.generatedImages} ảnh AI</p></div>
                <span className={`ui-status ${snapshot.readyMedia > 0 ? "is-success" : "is-warning"}`}>{snapshot.readyMedia > 0 ? "Có dữ liệu" : "Chưa có ảnh"}</span>
              </div>
            </div>
          </article>
        </div>

        <article className="ui-panel">
          <header className="ui-panel-header">
            <div><h2>Lịch sắp tới</h2><p>Các bài đang chờ đến giờ đăng hoặc xác nhận.</p></div>
            <Link href="/calendar">Xem lịch <AppIcon name="arrow-right" size={15} /></Link>
          </header>
          {snapshot.upcoming.length ? (
            <div className="ui-list">
              {snapshot.upcoming.map((item, index) => (
                <div className="ui-list-row" key={`${item.scheduled_for}-${item.provider}-${index}`}>
                  <ProviderBadge provider={item.provider} />
                  <div>
                    <strong>{item.title || item.body || "Nội dung đã lên lịch"}</strong>
                    <p>{providerNames[item.provider] || item.provider} · {timeFormatter.format(item.scheduled_for)} ngày {shortDateFormatter.format(item.scheduled_for)}</p>
                  </div>
                  <Status status={item.status} />
                </div>
              ))}
            </div>
          ) : (
            <div className="ui-empty">
              <span className="ui-empty-icon"><AppIcon name="calendar" size={22} /></span>
              <strong>Chưa có bài sắp đăng</strong>
              <p>Tạo nội dung và kích hoạt lịch để hệ thống tự đưa bài vào hàng đợi.</p>
              <Link className="ui-button" href="/automation">Mở AI Automation</Link>
            </div>
          )}
        </article>
      </section>

      <section className="ui-grid-2 ui-section-gap">
        <article className="ui-panel">
          <header className="ui-panel-header">
            <div><h2>Kênh phân phối</h2><p>Trạng thái kết nối social và kênh bán.</p></div>
            <Link href="/connections">Tất cả kênh <AppIcon name="arrow-right" size={15} /></Link>
          </header>
          <div className="ui-list">
            {distributionProviders.map((provider) => {
              const isConnected = connected.has(provider);
              const connection = snapshot.connections.find((item) => item.provider === provider);
              return (
                <div className="ui-list-row" key={provider}>
                  <ProviderBadge provider={provider} />
                  <div><strong>{providerNames[provider]}</strong><p>{connection?.display_name || "Chưa có tài khoản hoạt động"}</p></div>
                  <span className={`ui-status ${isConnected ? "is-success" : "is-warning"}`}>{isConnected ? "Đã kết nối" : "Chờ cấu hình"}</span>
                </div>
              );
            })}
          </div>
          <div className="ui-panel-padding ui-panel-divider">
            <span className={`ui-status ${distributionReady === distributionProviders.length ? "is-success" : "is-info"}`}>{distributionReady}/{distributionProviders.length} kênh sẵn sàng</span>
          </div>
        </article>

        <article className="ui-panel">
          <header className="ui-panel-header">
            <div><h2>Hoạt động gần đây</h2><p>Trạng thái xác nhận từ hàng đợi xuất bản.</p></div>
            <Link href="/activity">Nhật ký <AppIcon name="arrow-right" size={15} /></Link>
          </header>
          {snapshot.recentActivity.length ? (
            <div className="ui-list">
              {snapshot.recentActivity.map((item) => (
                <div className="ui-list-row" key={item.id}>
                  <ProviderBadge provider={item.provider} />
                  <div><strong>{item.title || providerNames[item.provider] || item.provider}</strong><p>{dateFormatter.format(item.updated_at)} · {timeFormatter.format(item.updated_at)}{item.error_message ? ` · ${item.error_message}` : ""}</p></div>
                  <Status status={item.status} />
                </div>
              ))}
            </div>
          ) : (
            <div className="ui-empty">
              <span className="ui-empty-icon"><AppIcon name="activity" size={22} /></span>
              <strong>Chưa có hoạt động xuất bản</strong>
              <p>Nhật ký sẽ được cập nhật sau tác vụ đầu tiên.</p>
            </div>
          )}
        </article>
      </section>
    </AppShell>
  );
}
