import type { Metadata } from "next";
import Link from "../SiteLink";
import { getDashboardSnapshot } from "../../lib/dashboard";
import {
  listPublishingActivity,
  PUBLISHING_PROVIDERS,
  type PublishingActivityEntry,
  type PublishingProvider,
} from "../../lib/publishing-history";
import { AppIcon } from "../ui/AppIcon";
import { AppShell } from "../ui/AppShell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Nhật ký hoạt động | TAHA AI",
  description: "Theo dõi lỗi, retry và kết quả xuất bản gần đây của TAHA AI.",
};

const providerNames: Record<PublishingProvider, string> = {
  facebook: "Facebook",
  website: "Website",
  zalo_personal: "Zalo",
  shopee: "Shopee",
  tiktok_shop: "TikTok",
};

const providerMarks: Record<PublishingProvider, string> = {
  facebook: "FB",
  website: "WEB",
  zalo_personal: "Z",
  shopee: "S",
  tiktok_shop: "TT",
};

const dayLabel = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "full",
  timeZone: "Asia/Ho_Chi_Minh",
});

const timeLabel = new Intl.DateTimeFormat("vi-VN", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Ho_Chi_Minh",
});

function vietnamDayKey(timestamp: number) {
  return new Date(timestamp + 7 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    published: "Đã đăng",
    queued: "Đang chờ",
    publishing: "Đang đăng",
    retry_wait: "Sẽ thử lại",
    awaiting_confirmation: "Chờ xác nhận",
    blocked: "Đang bị chặn",
    failed: "Thất bại",
    cancelled: "Đã hủy",
  };
  return labels[status] || status;
}

function statusTone(status: string) {
  if (status === "published") return "is-success";
  if (status === "failed" || status === "blocked") return "is-danger";
  if (status === "retry_wait" || status === "awaiting_confirmation") return "is-warning";
  return "is-info";
}

function activityTimestamp(entry: PublishingActivityEntry) {
  if (entry.status === "published") return entry.completedAt ?? entry.updatedAt;
  if (["queued", "publishing", "retry_wait", "awaiting_confirmation"].includes(entry.status)) return entry.scheduledFor;
  return entry.completedAt ?? entry.updatedAt;
}

function productLabel(entry: PublishingActivityEntry) {
  if (entry.sku && entry.productName) return `${entry.sku} — ${entry.productName}`;
  return entry.sku || entry.productName || entry.title || "Tác vụ xuất bản";
}

function safeExternalUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

type PageProps = {
  searchParams: Promise<{ channel?: string }>;
};

export default async function ActivityPage({ searchParams }: PageProps) {
  const [snapshot, activity, query] = await Promise.all([
    getDashboardSnapshot(),
    listPublishingActivity(),
    searchParams,
  ]);
  const selectedProvider = PUBLISHING_PROVIDERS.includes(query.channel as PublishingProvider)
    ? query.channel as PublishingProvider
    : "facebook";
  const providerCounts = activity.reduce((counts, item) => {
    counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
    return counts;
  }, new Map<PublishingProvider, number>());
  const selectedActivity = activity.filter((item) => item.provider === selectedProvider);
  const successCount = selectedActivity.filter((item) => item.status === "published").length;
  const failedCount = selectedActivity.filter((item) => item.status === "failed" || item.status === "blocked").length;
  const waitingCount = selectedActivity.filter((item) => ["queued", "publishing", "retry_wait", "awaiting_confirmation"].includes(item.status)).length;
  const activityDays = [...selectedActivity.reduce((groups, entry) => {
    const timestamp = activityTimestamp(entry);
    const key = vietnamDayKey(timestamp);
    const current = groups.get(key) ?? [];
    current.push(entry);
    groups.set(key, current);
    return groups;
  }, new Map<string, PublishingActivityEntry[]>())].map(([date, entries]) => ({ date, entries }));

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

      <section className="ui-kpi-grid" aria-label="Tổng quan hoạt động">
        <article className="ui-kpi"><span className="ui-kpi-icon"><AppIcon name="activity" size={21} /></span><span>Bài của {providerNames[selectedProvider]}</span><strong>{selectedActivity.length}</strong><small>Toàn bộ dữ liệu đã lưu, không giới hạn 5 bài.</small></article>
        <article className="ui-kpi is-success"><span className="ui-kpi-icon"><AppIcon name="check" size={21} /></span><span>Đã đăng</span><strong>{successCount}</strong><small>Provider đã xác nhận hoàn tất.</small></article>
        <article className={waitingCount ? "ui-kpi is-warning" : "ui-kpi is-success"}><span className="ui-kpi-icon"><AppIcon name="clock" size={21} /></span><span>Đang chờ / xử lý</span><strong>{waitingCount}</strong><small>Chờ giờ đăng, đang đăng, retry hoặc xác nhận.</small></article>
        <article className={failedCount ? "ui-kpi is-danger" : "ui-kpi is-success"}><span className="ui-kpi-icon"><AppIcon name={failedCount ? "alert" : "check"} size={21} /></span><span>Thất bại / bị chặn</span><strong>{failedCount}</strong><small>Cần kiểm tra lỗi provider hoặc dữ liệu.</small></article>
      </section>

      <article className="ui-panel">
        <nav className="activity-channel-tabs" aria-label="Lọc nhật ký theo kênh">
          {PUBLISHING_PROVIDERS.map((provider) => {
            const count = providerCounts.get(provider) ?? 0;
            return <Link
              className={`activity-channel-tab ${provider}${selectedProvider === provider ? " is-active" : ""}`}
              href={`/activity?channel=${provider}`}
              aria-current={selectedProvider === provider ? "page" : undefined}
              key={provider}
            ><span className={`ui-provider-badge ${provider}`}>{providerMarks[provider]}</span><strong>{providerNames[provider]}</strong><b>{count}</b></Link>;
          })}
        </nav>
        <header className="ui-panel-header activity-log-heading"><div><h2>Lịch sử {providerNames[selectedProvider]}</h2><p>{activityDays.length} ngày · {selectedActivity.length} bài · hiển thị đầy đủ theo thời gian mới nhất.</p></div></header>
        {activityDays.length ? <div className="publication-activity">{activityDays.map((day) => (
          <section className="publication-day activity-day" key={day.date}>
            <header className="publication-day-header">
              <div><time dateTime={day.date}>{dayLabel.format(activityTimestamp(day.entries[0]))}</time><small>Múi giờ Việt Nam</small></div>
              <span>{day.entries.length} bài</span>
            </header>
            <div className="ui-list">{day.entries.map((item) => {
              const happenedAt = activityTimestamp(item);
              const externalUrl = safeExternalUrl(item.externalUrl);
              return (
                <div className="ui-list-row activity-entry" key={item.id}>
                  <span className={`ui-provider-badge ${item.provider}`}>{providerMarks[item.provider]}</span>
                  <div>
                    <strong>{item.productId ? <Link className="publication-product-link" href={`/products/${encodeURIComponent(item.productId)}`}>{productLabel(item)}</Link> : productLabel(item)}</strong>
                    <p>{timeLabel.format(happenedAt)} · {item.title && item.title !== item.productName ? `${item.title} · ` : ""}{item.errorMessage ? `Lỗi: ${item.errorMessage}` : providerNames[item.provider]}</p>
                    {externalUrl ? <a className="ui-link activity-external-link" href={externalUrl} target="_blank" rel="noreferrer">Mở bài đã đăng <AppIcon name="arrow-right" size={13} /></a> : null}
                  </div>
                  <span className={`ui-status ${statusTone(item.status)}`}>{statusLabel(item.status)}</span>
                </div>
              );
            })}</div>
          </section>
        ))}</div> : <div className="ui-empty"><span className="ui-empty-icon"><AppIcon name="activity" size={22} /></span><strong>Chưa có hoạt động {providerNames[selectedProvider]}</strong><p>Khi kênh này có tác vụ đăng bài, toàn bộ sản phẩm và trạng thái sẽ xuất hiện tại đây.</p></div>}
      </article>
    </AppShell>
  );
}
