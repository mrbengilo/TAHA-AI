import type { Metadata } from "next";
import Link from "../../SiteLink";
import { AppIcon } from "../../ui/AppIcon";
import { AppShell } from "../../ui/AppShell";
import PostTemplateEditor from "./PostTemplateEditor";
import "./post-template.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Bài viết mẫu | TAHA AI",
  description: "Quản lý cấu trúc bài viết sản phẩm dùng chung cho các kênh của TAHA AI.",
};

export default function PostTemplatePage() {
  return (
    <AppShell
      active="settings"
      contextTitle="Bài viết mẫu"
      headerActions={(
        <Link className="ui-button" href="/settings">
          <AppIcon name="settings" size={17} /> Cài đặt
        </Link>
      )}
    >
      <PostTemplateEditor />
    </AppShell>
  );
}
