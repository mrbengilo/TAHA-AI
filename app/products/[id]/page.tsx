import Link from "../../SiteLink";
import { AppShell } from "../../ui/AppShell";
import ProductFolder from "./ProductFolder";

export const dynamic = "force-dynamic";
export const metadata = { title: "Thư mục sản phẩm | TAHA AI" };
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AppShell active="products" contextTitle="Thư mục sản phẩm" headerActions={<Link className="ui-button" href="/products">Tất cả sản phẩm</Link>}><ProductFolder productId={id} /></AppShell>;
}
