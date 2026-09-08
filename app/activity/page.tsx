import type { Metadata } from "next";
import Link from "../SiteLink";
import { getDashboardSnapshot } from "../../lib/dashboard";
import {
  listPublishingActivity,
  PUBLISHING_PROVIDERS,
  type PublishingProvider,
} from "../../lib/publishing-history";
import { AppIcon } from "../ui/AppIcon";
import { AppShell } from "../ui/AppShell";
import ActivityLog from "./ActivityLog";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Nhật ký hoạt động | TAHA AI",
  description: "Theo dõi lỗi, retry và kết quả xuất bản gần đây của TAHA AI.",
};

type PageProps = {
  searchParams: Promise<{ channel?: string }>;
};

export default async function ActivityPage({ searchParams }: PageProps) {
  const [snapshot, activity, query] = await Promise.all([
    getDashboardSnapshot(),
    listPublishingActivity(),
    searchParams,
  ]);
  const initialProvider = PUBLISHING_PROVIDERS.includes(query.channel as PublishingProvider)
    ? query.channel as PublishingProvider
    : "facebook";

  return (
    <AppShell
      active="activity"
      contextTitle="Nhật ký hoạt động"
      noticeCount={snapshot.attentionCount + snapshot.reviewCount}
      headerActions={<Link className="ui-button" href="/channels"><AppIcon name="connections" size={17} /> Chẩn đoán connector</Link>}
    >
      <section className="ui-page-header">
        <div className="ui-page-header-copy">
          <span className="ui-eyebrow">OPERATIONS LOG</span>
          <h1>Toàn bộ lịch sử đăng bài, tách riêng từng kênh</h1>
          <p>Chọn Facebook, Website, Zalo, Shopee hoặc TikTok để xem đầy đủ từng sản phẩm, thời gian đăng và trạng thái.</p>
        </div>
        <div className="ui-page-actions"><Link className="ui-button" href="/connections"><AppIcon name="settings" size={17} /> Kiểm tra kết nối</Link></div>
      </section>

      <ActivityLog activity={activity} initialProvider={initialProvider} />
    </AppShell>
  );
}
