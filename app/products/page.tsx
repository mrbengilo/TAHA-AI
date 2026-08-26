import type { Metadata } from "next";
import Link from "../SiteLink";
import { getChannelLibrary } from "../../lib/channel-library";
import { AppIcon } from "../ui/AppIcon";
import { AppShell } from "../ui/AppShell";
import { ProductsView } from "./ProductsView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sản phẩm | TAHA AI",
  description: "Quản lý sản phẩm theo SKU, kiểm tra dữ liệu và hình ảnh trước khi tạo nội dung hoặc đăng đa kênh.",
};

export default async function ProductsPage() {
  let products: Awaited<ReturnType<typeof getChannelLibrary>>["products"] = [];
  let error: string | null = null;
  try {
    const library = await getChannelLibrary("google_sheets", 100);
    products = library.products;
  } catch (reason) {
    error = reason instanceof Error ? reason.message : "Không thể tải danh sách sản phẩm.";
  }

  const activeCount = products.filter((product) => product.status === "active").length;
  const missingMediaCount = products.filter((product) => !product.previewUrl).length;
  const draftCount = products.filter((product) => product.status === "draft").length;

  return (
    <AppShell
      active="products"
      contextTitle="Sản phẩm"
      headerActions={<Link className="ui-button is-primary" href="/connections"><AppIcon name="sync" size={17} /> Đồng bộ Google</Link>}
    >
      <section className="ui-page-header">
        <div className="ui-page-header-copy">
          <span className="ui-eyebrow">PRODUCT MASTER</span>
          <h1>Sản phẩm là trung tâm vận hành</h1>
          <p>Mỗi SKU tập hợp dữ liệu Google Sheets, ảnh trong thư mục Drive dạng <strong>SKU &lt;mã SKU&gt;</strong>, nội dung AI và trạng thái xuất bản.</p>
        </div>
        <div className="ui-page-actions">
          <Link className="ui-button" href="/channels/google_sheets"><AppIcon name="settings" size={17} /> Dữ liệu nâng cao</Link>
          <Link className="ui-button" href="/automation"><AppIcon name="automation" size={17} /> Tạo nội dung AI</Link>
          <Link className="ui-button is-primary" href="/automation"><AppIcon name="publish" size={17} /> Đăng sản phẩm</Link>
        </div>
      </section>

      <section className="ui-kpi-grid" aria-label="Tình trạng sản phẩm">
        <article className="ui-kpi"><span className="ui-kpi-icon"><AppIcon name="products" size={21} /></span><span>Tổng sản phẩm</span><strong>{products.length}</strong><small>Sản phẩm đã được nhập vào Product Master.</small></article>
        <article className="ui-kpi is-success"><span className="ui-kpi-icon"><AppIcon name="check" size={21} /></span><span>Đang hoạt động</span><strong>{activeCount}</strong><small>Có trạng thái bán hàng đang hoạt động.</small></article>
        <article className={missingMediaCount ? "ui-kpi is-warning" : "ui-kpi is-success"}><span className="ui-kpi-icon"><AppIcon name="image" size={21} /></span><span>Thiếu hình ảnh</span><strong>{missingMediaCount}</strong><small>Chưa có ảnh sẵn sàng gắn với sản phẩm.</small></article>
        <article className={draftCount ? "ui-kpi is-warning" : "ui-kpi"}><span className="ui-kpi-icon"><AppIcon name="clock" size={21} /></span><span>Bản nháp</span><strong>{draftCount}</strong><small>Cần kiểm tra trước khi đưa vào automation.</small></article>
      </section>

      {error ? (
        <div className="ui-panel"><div className="ui-error"><span className="ui-error-icon"><AppIcon name="alert" size={22} /></span><strong>Chưa tải được sản phẩm</strong><p>{error}</p><Link className="ui-button" href="/connections">Kiểm tra kết nối Google</Link></div></div>
      ) : products.length ? (
        <ProductsView products={products} />
      ) : (
        <div className="ui-panel"><div className="ui-empty"><span className="ui-empty-icon"><AppIcon name="products" size={22} /></span><strong>Chưa có sản phẩm</strong><p>Kết nối Google, đảm bảo Sheet có cột SKU rồi bấm đồng bộ.</p><Link className="ui-button is-primary" href="/connections">Kết nối và đồng bộ</Link></div></div>
      )}
    </AppShell>
  );
}
