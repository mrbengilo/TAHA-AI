import type { Metadata } from "next";
import { ConnectionCenter } from "./ConnectionCenter";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Kết nối kênh | TAHA AI",
  description: "Kết nối nguồn dữ liệu và các kênh bán hàng của TAHA AI.",
};

export default function ConnectionsPage() {
  return <ConnectionCenter />;
}
