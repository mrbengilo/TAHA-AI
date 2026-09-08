import type { Metadata } from "next";
import Link from "../SiteLink";
import { getDashboardSnapshot } from "../../lib/dashboard";
import { AppIcon } from "../ui/AppIcon";
import { AppShell } from "../ui/AppShell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lịch đăng | TAHA AI",
  description: "Theo dõi lịch social automation và các bài đang chờ xuất bản.",
};

const providerNames: Record<string, string> = {
  facebook: "Facebook",
  zalo_personal: "Zalo cá nhân",
  website: "Website",
  shopee: "Shopee",
  tiktok_shop: "TikTok Shop",
  google: "Google",
};

const dateTime = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Ho_Chi_Minh",
});

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

export default async function CalendarPage() {
  const snapshot = await getDashboardSnapshot();
  const now = snapshot.capturedAt;
  const waitingCount = snapshot.calendarJobs.filter((item) => item.status === "queued" || item.status === "retry_wait").length;
  const assistedCount = snapshot.calendarJobs.filter((item) => item.status === "awaiting_confirmation").length;

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
          <h1>Lịch social rõ ràng, không đăng trùng</h1>
          <p>Theo dõi lịch đang hoạt động, tác vụ đến hạn và những bài Zalo cần chủ tài khoản xác nhận.</p>
        </div>
        <div className="ui-page-actions">
          <Link className="ui-button" href="/channels?view=schedules"><AppIcon name="settings" size={17} /> Quản lý nâng cao</Link>
          <Link className="ui-button is-primary" href="/automation"><AppIcon name="automation" size={17} /> Mở Automation</Link>
        </div>
      </section>

      <section className="ui-kpi-grid" aria-label="Tổng quan lịch đăng">
        <article className="ui-kpi"><span className="ui-kpi-icon"><AppIcon name="calendar" size={21} /></span><span>Lịch hoạt động</span><strong>{snapshot.activeScheduleCount}</strong><small>Đang được scheduler theo dõi.</small></article>
        <article className="ui-kpi"><span className="ui-kpi-icon"><AppIcon name="clock" size={21} /></span><span>Cần theo dõi</span><strong>{snapshot.calendarJobs.length}</strong><small>Tác vụ chờ, quá hạn hoặc cần xử lý.</small></article>
        <article className={waitingCount ? "ui-kpi is-warning" : "ui-kpi is-success"}><span className="ui-kpi-icon"><AppIcon name="publish" size={21} /></span><span>Đang chờ</span><strong>{waitingCount}</strong><small>Chờ đến giờ hoặc chờ thử lại.</small></article>
        <article className={assistedCount ? "ui-kpi is-warning" : "ui-kpi is-success"}><span className="ui-kpi-icon"><AppIcon name="check" size={21} /></span><span>Cần xác nhận</span><strong>{assistedCount}</strong><small>Chủ tài khoản cần hoàn tất thao tác.</small></article>
      </section>

      <section className="ui-grid-2">
        <article className="ui-panel">
          <header className="ui-panel-header"><div><h2>Lịch đang hoạt động</h2><p>Cấu hình lặp lại theo múi giờ Việt Nam.</p></div></header>
          {snapshot.activeSchedules.length ? <div className="ui-list">{snapshot.activeSchedules.map((item) => (
            <div className="ui-list-row" key={item.id}>
              <span className="ui-list-icon"><AppIcon name="calendar" size={19} /></span>
              <div><strong>{item.title || (item.provider === "zalo_personal" ? "Chuẩn bị bài Zalo cá nhân" : `Tự động đăng ${providerNames[item.provider] || item.provider}`)}</strong><p>{providerNames[item.provider] || item.provider} · {item.local_time || (item.next_run_at ? dateTime.format(item.next_run_at) : "Theo lịch")}{item.provider === "zalo_personal" ? " · đăng thủ công" : ""}</p></div>
              <span className="ui-status is-success">Đang chạy</span>
            </div>
          ))}</div> : <div className="ui-empty"><span className="ui-empty-icon"><AppIcon name="calendar" size={22} /></span><strong>Chưa có lịch hoạt động</strong><p>Tạo nội dung, duyệt và kích hoạt lịch để bắt đầu.</p><Link className="ui-button" href="/automation">Tạo nội dung</Link></div>}
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
