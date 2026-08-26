import type { Metadata } from "next";
import Link from "../SiteLink";
import { AppIcon } from "../ui/AppIcon";
import { AppShell } from "../ui/AppShell";
import { ConnectionCenter } from "./ConnectionCenter";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Kết nối kênh | TAHA AI",
  description: "Kết nối nguồn dữ liệu và các kênh bán hàng của TAHA AI.",
};

export default function ConnectionsPage() {
  return (
    <AppShell
      active="connections"
      contextTitle="Kênh kết nối"
      headerActions={<Link className="ui-button" href="/channels"><AppIcon name="activity" size={17} /> Chẩn đoán connector</Link>}
    >
      <ConnectionCenter />
    </AppShell>
  );
}
