import type { Metadata } from "next";
import Link from "../SiteLink";
import { listChannelSummaries } from "../../lib/channel-library";
import { AppIcon } from "../ui/AppIcon";
import { AppShell } from "../ui/AppShell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Cài đặt | TAHA AI",
  description: "Cấu hình nguồn dữ liệu, kênh đích và nguyên tắc vận hành TAHA AI.",
};

export default async function SettingsPage() {
  let channels: Awaited<ReturnType<typeof listChannelSummaries>> = [];
  let error: string | null = null;
  try {
    channels = await listChannelSummaries();
  } catch (reason) {
    error = reason instanceof Error ? reason.message : "Không thể đọc trạng thái hệ thống.";
  }
  const readyCount = channels.filter((item) => item.status === "connected" || item.status === "assisted").length;

  return (
    <AppShell
      active="settings"
      contextTitle="Cài đặt"
      noticeCount={channels.filter((item) => item.status === "error" || item.status === "expired").length}
      headerActions={<Link className="ui-button is-primary" href="/connections"><AppIcon name="connections" size={17} /> Quản lý kết nối</Link>}
    >
      <section className="ui-page-header">
        <div className="ui-page-header-copy">
          <span className="ui-eyebrow">SYSTEM SETTINGS</span>
          <h1>Cài đặt theo luồng vận hành, không theo thuật ngữ kỹ thuật</h1>
          <p>Google là nguồn dữ liệu; Facebook và Zalo là social; Website, Shopee và TikTok Shop là kênh bán hàng.</p>
        </div>
        <div className="ui-page-actions">
          <Link className="ui-button" href="/connections/guide"><AppIcon name="help" size={17} /> Hướng dẫn</Link>
          <Link className="ui-button is-primary" href="/connections"><AppIcon name="settings" size={17} /> Kết nối kênh</Link>
        </div>
      </section>

      <section className="ui-grid-2">
        <article className="ui-panel">
          <header className="ui-panel-header"><div><h2>Nguồn dữ liệu</h2><p>Quy tắc chuẩn cho Product Master.</p></div></header>
          <div className="ui-list">
            <div className="ui-list-row"><span className="ui-list-icon"><AppIcon name="products" size={19} /></span><div><strong>Google Sheets</strong><p>SKU là khóa sản phẩm chính và phải duy nhất.</p></div><Link href="/channels/google_sheets">Mở</Link></div>
            <div className="ui-list-row"><span className="ui-list-icon"><AppIcon name="image" size={19} /></span><div><strong>Google Drive</strong><p>SKU PH0006 được ánh xạ chính xác tới thư mục “SKU PH0006”.</p></div><Link href="/channels/google_drive">Mở</Link></div>
          </div>
        </article>

        <article className="ui-panel">
          <header className="ui-panel-header"><div><h2>Tình trạng kênh</h2><p>{readyCount}/{channels.length || 7} kênh đang sẵn sàng.</p></div><Link href="/connections">Chi tiết <AppIcon name="arrow-right" size={15} /></Link></header>
          {error ? <div className="ui-error"><span className="ui-error-icon"><AppIcon name="alert" size={22} /></span><strong>Chưa đọc được trạng thái</strong><p>{error}</p></div> : <div className="ui-list">{channels.map((channel) => (
            <div className="ui-list-row" key={channel.id}>
              <span className="ui-list-icon"><AppIcon name="connections" size={19} /></span>
              <div><strong>{channel.name}</strong><p>{channel.description}</p></div>
              <span className={`ui-status ${channel.status === "connected" || channel.status === "assisted" ? "is-success" : channel.status === "error" || channel.status === "expired" ? "is-danger" : "is-warning"}`}>{channel.status === "connected" ? "Đã kết nối" : channel.status === "assisted" ? "Có xác nhận" : channel.status === "expired" ? "Hết phiên" : channel.status === "error" ? "Có lỗi" : "Chờ thiết lập"}</span>
            </div>
          ))}</div>}
        </article>
      </section>

      <section className="ui-grid-2 ui-section-gap">
        <article className="ui-panel"><header className="ui-panel-header"><div><h2>Nguyên tắc an toàn</h2><p>Các quy tắc không được phá vỡ.</p></div></header><div className="ui-list"><div className="ui-list-row"><span className="ui-list-icon"><AppIcon name="check" size={19} /></span><div><strong>Không đăng trùng</strong><p>Mọi retry phải dùng idempotency key.</p></div></div><div className="ui-list-row"><span className="ui-list-icon"><AppIcon name="check" size={19} /></span><div><strong>Không báo thành công giả</strong><p>Chỉ hiển thị thành công khi provider đã xác nhận.</p></div></div></div></article>
        <article className="ui-panel"><header className="ui-panel-header"><div><h2>Công cụ nâng cao</h2><p>Dành cho kiểm tra kỹ thuật khi cần.</p></div></header><div className="ui-list"><div className="ui-list-row"><span className="ui-list-icon"><AppIcon name="activity" size={19} /></span><div><strong>Chẩn đoán từng connector</strong><p>Media, draft, queue và lịch sử của từng kênh.</p></div><Link href="/channels">Mở</Link></div><div className="ui-list-row"><span className="ui-list-icon"><AppIcon name="help" size={19} /></span><div><strong>Hướng dẫn kết nối</strong><p>Callback, quyền cần cấp và bước kiểm tra.</p></div><Link href="/connections/guide">Mở</Link></div></div></article>
      </section>
    </AppShell>
  );
}
