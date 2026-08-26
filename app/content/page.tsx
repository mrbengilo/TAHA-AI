import type { Metadata } from "next";
import Link from "../SiteLink";
import { getChannelLibrary } from "../../lib/channel-library";
import { AppIcon } from "../ui/AppIcon";
import { AppShell } from "../ui/AppShell";
import { MediaGrid } from "./MediaGrid";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Nội dung và Media | TAHA AI",
  description: "Theo dõi ảnh gốc từ Google Drive, ảnh AI và nội dung dùng cho các kênh.",
};

export default async function ContentPage() {
  let library: Awaited<ReturnType<typeof getChannelLibrary>> | null = null;
  let error: string | null = null;
  try {
    library = await getChannelLibrary("google_drive", 100);
  } catch (reason) {
    error = reason instanceof Error ? reason.message : "Không thể tải kho hình ảnh.";
  }

  const media = library?.media ?? [];
  const sourceCount = media.filter((item) => item.origin === "source").length;
  const generatedCount = media.filter((item) => item.origin === "generated").length;
  const readyCount = media.filter((item) => item.status === "ready").length;
  const failedCount = media.filter((item) => item.status === "failed").length;

  return (
    <AppShell
      active="content"
      contextTitle="Nội dung & Media"
      noticeCount={failedCount}
      headerActions={<Link className="ui-button is-primary" href="/automation"><AppIcon name="automation" size={17} /> Tạo nội dung AI</Link>}
    >
      <section className="ui-page-header">
        <div className="ui-page-header-copy">
          <span className="ui-eyebrow">CONTENT LIBRARY</span>
          <h1>Hình ảnh và nội dung theo đúng SKU</h1>
          <p>Ảnh nguồn được đọc từ thư mục Drive dạng <strong>SKU PH0006</strong>. Ảnh AI được gắn lại đúng sản phẩm và có thể đồng bộ về cùng thư mục.</p>
        </div>
        <div className="ui-page-actions">
          <Link className="ui-button" href="/connections"><AppIcon name="sync" size={17} /> Đồng bộ nguồn</Link>
          <Link className="ui-button" href="/channels/google_drive"><AppIcon name="settings" size={17} /> Kho Drive nâng cao</Link>
          <Link className="ui-button is-primary" href="/automation"><AppIcon name="plus" size={17} /> Tạo ảnh & nội dung</Link>
        </div>
      </section>

      <section className="ui-kpi-grid" aria-label="Thống kê media">
        <article className="ui-kpi"><span className="ui-kpi-icon"><AppIcon name="image" size={21} /></span><span>Ảnh gốc</span><strong>{sourceCount}</strong><small>Được nhập từ Google Drive.</small></article>
        <article className="ui-kpi"><span className="ui-kpi-icon"><AppIcon name="automation" size={21} /></span><span>Ảnh AI</span><strong>{generatedCount}</strong><small>Được tạo và lưu theo Product/SKU.</small></article>
        <article className="ui-kpi is-success"><span className="ui-kpi-icon"><AppIcon name="check" size={21} /></span><span>Sẵn sàng</span><strong>{readyCount}</strong><small>Có thể dùng để tạo bài hoặc listing.</small></article>
        <article className={failedCount ? "ui-kpi is-danger" : "ui-kpi is-success"}><span className="ui-kpi-icon"><AppIcon name={failedCount ? "alert" : "check"} size={21} /></span><span>Có lỗi</span><strong>{failedCount}</strong><small>Media cần kiểm tra hoặc đồng bộ lại.</small></article>
      </section>

      {error ? (
        <div className="ui-panel"><div className="ui-error"><span className="ui-error-icon"><AppIcon name="alert" size={22} /></span><strong>Chưa tải được kho media</strong><p>{error}</p><Link className="ui-button" href="/connections">Kiểm tra kết nối Google</Link></div></div>
      ) : media.length ? (
        <MediaGrid media={media} />
      ) : (
        <div className="ui-panel"><div className="ui-empty"><span className="ui-empty-icon"><AppIcon name="image" size={22} /></span><strong>Chưa có hình ảnh</strong><p>Đảm bảo thư mục Drive của mỗi sản phẩm có tên “SKU &lt;mã SKU&gt;”, sau đó đồng bộ lại.</p><Link className="ui-button is-primary" href="/connections">Đồng bộ Google</Link></div></div>
      )}
    </AppShell>
  );
}
