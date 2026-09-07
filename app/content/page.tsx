import Link from "../SiteLink";
import { getChannelLibrary } from "../../lib/channel-library";
import { ProductsView } from "../products/ProductsView";
import { AppShell } from "../ui/AppShell";
export const dynamic = "force-dynamic";
export const metadata = { title: "Thư mục nội dung theo SKU | TAHA AI" };
export default async function ContentPage() {
  let products: Awaited<ReturnType<typeof getChannelLibrary>>["products"] = [];
  let failed = false;
  try { products = (await getChannelLibrary("google_sheets", 100)).products; } catch { failed = true; }
  return <AppShell active="content" contextTitle="Nội dung theo SKU"><section className="ui-page-header"><div className="ui-page-header-copy"><span className="ui-eyebrow">THƯ MỤC SẢN PHẨM</span><h1>Hình ảnh và bài viết theo SKU</h1><p>Mở một thư mục để xem riêng ảnh gốc Drive, thông tin từ Sheets, bài viết AI và lịch đăng của cùng sản phẩm.</p></div><Link className="ui-button" href="/connections">Đồng bộ Google</Link></section>{failed ? <div className="ui-panel" role="alert">Không thể tải thư mục sản phẩm. Kiểm tra kết nối Google.</div> : <ProductsView products={products}/>}</AppShell>;
}
