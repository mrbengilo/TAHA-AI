import type { Metadata } from "next";
import Link from "../SiteLink";
import { getDashboardSnapshot } from "../../lib/dashboard";
import {
  listPublishingCalendar,
  type PublishingCalendarEntry,
  type PublishingProvider,
} from "../../lib/publishing-history";
import { AppIcon } from "../ui/AppIcon";
import { AppShell } from "../ui/AppShell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lịch đăng | TAHA AI",
  description: "Theo dõi lịch social automation và các bài đang chờ xuất bản.",
};

const providerNames: Record<string, string> = {
  facebook: "Facebook",
  zalo_personal: "Zalo",
  website: "Website",
  shopee: "Shopee",
  tiktok_shop: "TikTok",
  google: "Google",
};

const providerMarks: Record<PublishingProvider, string> = {
  facebook: "FB",
  website: "WEB",
  zalo_personal: "Z",
  shopee: "S",
  tiktok_shop: "TT",
};

const dateTime = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Ho_Chi_Minh",
});

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

function statusTone(status: string) {
  if (status === "published") return "is-success";
  if (status === "failed" || status === "blocked") return "is-danger";
  if (status === "retry_wait" || status === "awaiting_confirmation") return "is-warning";
  return "is-info";
}

function jobStatusLabel(status: string, scheduledFor: number, now: number) {
  if (status === "awaiting_confirmation") return "Cần tự đăng";
  if (status === "retry_wait") return "Sẽ thử lại";
  if (status === "failed") return "Đăng thất bại";
  if (status === "blocked") return "Bị chặn";
  if (status === "queued" && scheduledFor <= now) return "Quá giờ · đang chờ";
  return "Đang chờ";
}

function jobStatusTone(status: string, scheduledFor: number, now: number) {
  if (status === "queued" && scheduledFor <= now) return "is-warning";
  return statusTone(status);
}

function calendarStatusLabel(status: string) {
  const labels: Record<string, string> = {
    awaiting_assignment: "Chờ gán sản phẩm",
    preparing: "Đang chuẩn bị",
    preparation_failed: "Chuẩn bị thất bại",
    scheduled: "Đã lên lịch",
    completed: "Đã chạy lịch",
    queued: "Đang chờ đăng",
    publishing: "Đang đăng",
    retry_wait: "Sẽ thử lại",
    awaiting_confirmation: "Cần tự đăng",
    published: "Đã đăng",
    failed: "Đăng thất bại",
    blocked: "Bị chặn",
    cancelled: "Đã hủy",
  };
  return labels[status] || status;
}

function calendarStatusTone(status: string) {
  if (status === "published" || status === "completed") return "is-success";
  if (status === "failed" || status === "blocked" || status === "preparation_failed") return "is-danger";
  if (status === "retry_wait" || status === "awaiting_confirmation" || status === "awaiting_assignment") return "is-warning";
  return "is-info";
}

function productLabel(entry: PublishingCalendarEntry) {
  if (entry.sku && entry.productName) return `${entry.sku} — ${entry.productName}`;
  if (entry.sku) return entry.sku;
  if (entry.productName) return entry.productName;
  if (entry.title) return entry.title;
  return "Chưa có sản phẩm sẵn sàng cho khung giờ này";
}

export default async function CalendarPage() {
  const [snapshot, calendarEntries] = await Promise.all([
    getDashboardSnapshot(),
    listPublishingCalendar(),
  ]);
  const now = snapshot.capturedAt;
  const assignedCount = calendarEntries.filter((item) => item.productId).length;
  const unassignedCount = calendarEntries.filter((item) => item.status === "awaiting_assignment").length;
  const attentionCount = calendarEntries.filter((item) => ["failed", "blocked", "preparation_failed", "retry_wait", "awaiting_confirmation"].includes(item.status)).length;
  const calendarDays = [...calendarEntries.reduce((groups, entry) => {
    const key = vietnamDayKey(entry.scheduledFor);
    const current = groups.get(key) ?? [];
    current.push(entry);
    groups.set(key, current);
    return groups;
  }, new Map<string, PublishingCalendarEntry[]>())].map(([date, entries]) => ({ date, entries }));

  return (
    <AppShell
      active="calendar"
      contextTitle="Lịch đăng"
      noticeCount={snapshot.attentionCount}
      headerActions={<Link className="ui-button is-primary" href="/automation"><AppIcon name="plus" size={17} /> Tạo nội dung</Link>}
    >
      <section className="ui-page-header">
        <div className="ui-page-header-copy">
          <span className="ui-eyebrow">PUBLISHING CALENDAR</span>
          <h1>Mỗi ngày có bao nhiêu bài, xem rõ từng sản phẩm</h1>
          <p>Lịch được chia theo ngày và theo kênh, kèm đúng sản phẩm, giờ đăng và trạng thái xử lý của từng bài.</p>
        </div>
        <div className="ui-page-actions">
          <Link className="ui-button" href="/channels?view=schedules"><AppIcon name="settings" size={17} /> Quản lý nâng cao</Link>
          <Link className="ui-button is-primary" href="/automation"><AppIcon name="automation" size={17} /> Mở Automation</Link>
        </div>
      </section>

      <section className="ui-kpi-grid" aria-label="Tổng quan lịch đăng">
        <article className="ui-kpi"><span className="ui-kpi-icon"><AppIcon name="calendar" size={21} /></span><span>Tổng số bài trên lịch</span><strong>{calendarEntries.length}</strong><small>Tất cả bài từ hôm nay trở đi.</small></article>
        <article className="ui-kpi is-success"><span className="ui-kpi-icon"><AppIcon name="check" size={21} /></span><span>Đã gán sản phẩm</span><strong>{assignedCount}</strong><small>Hiển thị rõ SKU và tên sản phẩm.</small></article>
        <article className={unassignedCount ? "ui-kpi is-warning" : "ui-kpi is-success"}><span className="ui-kpi-icon"><AppIcon name="clock" size={21} /></span><span>Chờ gán sản phẩm</span><strong>{unassignedCount}</strong><small>Lịch đã lưu nhưng nội dung đang được chuẩn bị.</small></article>
        <article className={attentionCount ? "ui-kpi is-danger" : "ui-kpi is-success"}><span className="ui-kpi-icon"><AppIcon name={attentionCount ? "alert" : "check"} size={21} /></span><span>Cần xử lý</span><strong>{attentionCount}</strong><small>Thất bại, bị chặn, retry hoặc cần xác nhận.</small></article>
      </section>

      <section className="publication-calendar-layout">
        <article className="ui-panel">
          <header className="ui-panel-header"><div><h2>Lịch đăng chi tiết theo ngày</h2><p>Mỗi ngày hiển thị tổng số bài và toàn bộ sản phẩm trong ngày đó.</p></div></header>
          {calendarDays.length ? <div className="publication-calendar">{calendarDays.map((day) => {
            const channelGroups = [...day.entries.reduce((groups, entry) => {
              const current = groups.get(entry.provider) ?? [];
              current.push(entry);
              groups.set(entry.provider, current);
              return groups;
            }, new Map<PublishingProvider, PublishingCalendarEntry[]>())];
            return (
              <section className="publication-day" key={day.date}>
                <header className="publication-day-header">
                  <div><time dateTime={day.date}>{dayLabel.format(day.entries[0].scheduledFor)}</time><small>Múi giờ Việt Nam</small></div>
                  <span>{day.entries.length} bài</span>
                </header>
                {channelGroups.map(([provider, entries]) => (
                  <section className="publication-channel-group" key={provider}>
                    <header className="publication-channel-header">
                      <span className={`ui-provider-badge ${provider}`}>{providerMarks[provider]}</span>
                      <strong>{providerNames[provider]}</strong>
                      <b>{entries.length} bài</b>
                    </header>
                    <div className="ui-list">{entries.map((entry) => (
                      <div className="ui-list-row publication-entry" key={entry.id}>
                        <time className="publication-time" dateTime={new Date(entry.scheduledFor).toISOString()}>{timeLabel.format(entry.scheduledFor)}</time>
                        <div>
                          <strong>{entry.productId ? <Link className="publication-product-link" href={`/products/${encodeURIComponent(entry.productId)}`}>{productLabel(entry)}</Link> : productLabel(entry)}</strong>
                          <p>{entry.title && entry.title !== entry.productName ? `${entry.title} · ` : ""}{providerNames[entry.provider]}{entry.errorMessage ? ` · ${entry.errorMessage}` : ""}</p>
                        </div>
                        <span className={`ui-status ${calendarStatusTone(entry.status)}`}>{calendarStatusLabel(entry.status)}</span>
                      </div>
                    ))}</div>
                  </section>
                ))}
              </section>
            );
          })}</div> : <div className="ui-empty"><span className="ui-empty-icon"><AppIcon name="calendar" size={22} /></span><strong>Chưa có bài trên lịch</strong><p>Cài ngày, số lượng bài và từng khung giờ trong Automation để bắt đầu.</p><Link className="ui-button" href="/automation">Cài lịch Facebook</Link></div>}
        </article>

        <article className="ui-panel">
          <header className="ui-panel-header"><div><h2>Tác vụ cần theo dõi</h2><p>Hiển thị cả bài quá giờ, thất bại, bị chặn và Zalo cần đăng thủ công.</p></div></header>
          {snapshot.calendarJobs.length ? <div className="ui-list">{snapshot.calendarJobs.map((item) => (
            <div className="ui-list-row" key={item.id}>
              <span className="ui-list-icon"><AppIcon name={item.status === "failed" || item.status === "blocked" ? "alert" : "clock"} size={19} /></span>
              <div><strong>{item.title || item.body || "Nội dung đã lên lịch"}</strong><p>{providerNames[item.provider] || item.provider} · {dateTime.format(item.scheduled_for)}{item.error_message ? ` · ${item.error_message}` : ""}</p>{item.provider === "zalo_personal" && item.status === "awaiting_confirmation" ? <Link className="ui-link" href={`/channels/zalo_personal?tab=activity&job=${encodeURIComponent(item.id)}`}>Mở đúng bài để sao chép và tự đăng <AppIcon name="arrow-right" size={14} /></Link> : null}</div>
              <span className={`ui-status ${jobStatusTone(item.status, item.scheduled_for, now)}`}>{jobStatusLabel(item.status, item.scheduled_for, now)}</span>
            </div>
          ))}</div> : <div className="ui-empty"><span className="ui-empty-icon"><AppIcon name="clock" size={22} /></span><strong>Chưa có bài sắp đăng</strong><p>Các tác vụ đến hạn sẽ xuất hiện tại đây.</p></div>}
        </article>
      </section>
    </AppShell>
  );
}
