import type { Metadata } from "next";
import Link from "../SiteLink";
import "./automation.css";
import AutomationCenter from "./AutomationCenter";
import { AppIcon } from "../ui/AppIcon";
import { AppShell } from "../ui/AppShell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AI Automation | TAHA AI",
  description: "Tạo ảnh, nội dung đa kênh và chuẩn bị đăng sản phẩm theo SKU.",
};

export default function AutomationPage() {
  return (
    <AppShell
      active="automation"
      contextTitle="AI Automation"
      headerActions={<Link className="ui-button" href="/products"><AppIcon name="products" size={17} /> Chọn sản phẩm</Link>}
    >
      <AutomationCenter />
    </AppShell>
  );
}
