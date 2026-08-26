import type { Metadata } from "next";
import Link from "../SiteLink";
import { AppIcon } from "../ui/AppIcon";
import { AppShell } from "../ui/AppShell";
import { ChannelHub } from "./ChannelHub";

export const metadata: Metadata = {
  title: "Chẩn đoán từng kênh | TAHA AI",
  description: "Theo dõi media, nội dung và lịch sử kỹ thuật của từng connector.",
};

export const dynamic = "force-dynamic";

export default function ChannelsPage() {
  return (
    <AppShell
      active="connections"
      contextTitle="Chẩn đoán từng kênh"
      headerActions={<Link className="ui-button is-primary" href="/connections"><AppIcon name="connections" size={17} /> Quản lý kết nối</Link>}
    >
      <ChannelHub />
    </AppShell>
  );
}
