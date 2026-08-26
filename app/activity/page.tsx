import type { Metadata } from "next";
import Link from "../SiteLink";
import { getDashboardSnapshot } from "../../lib/dashboard";
import { AppIcon } from "../ui/AppIcon";
import { AppShell } from "../ui/AppShell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Nhật ký hoạt động | TAHA AI",
  description: "Theo dõi lỗi, retry và kết quả xuất bản gần đây của TAHA AI.",
};

const providerNames: Record<string, string> = {
  google: "Google",
  facebook: "Facebook",
  zalo_personal: "Zalo cá nhân",
  website: "Website",
  shopee: "Shopee",
  tiktok_shop: "TikTok Shop",
};

const dateTime = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Ho_Chi_Minh",
});

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

export default async function ActivityPage() {
  const snapshot = await getDashboardSnapshot();
  const successCount = snapshot.recentActivity.filter((item) => item.status === "published").length;
  const failedCount = snapshot.recentActivity.filter((item) => item.status === "failed" || item.status === "blocked").length;

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
          <h1>Biết chính xác hệ thống đã làm gì</h1>
          <p>Phân biệt rõ tác vụ thành công, đang chờ, cần xác nhận, retry và thất bại. Không biến lỗi thành trạng thái thành công.</p>
        </div>
        <div className="ui-page-actions"><Link className="ui-button" href="/connections"><AppIcon name="settings" size={17} /> Kiểm tra kết nối</Link></div>
      </section>

      <section className="ui-kpi-grid" aria-label="Tổng quan hoạt động">
        <article className="ui-kpi"><span className="ui-kpi-icon"><AppIcon name="activity" size={21} /></span><span>Hoạt động gần đây</span><strong>{snapshot.recentActivity.length}</strong><small>Các job mới nhất được hệ thống ghi nhận.</small></article>
        <article className="ui-kpi is-success"><span className="ui-kpi-icon"><AppIcon name="check" size={21} /></span><span>Đã đăng</span><strong>{successCount}</strong><small>Provider đã xác nhận hoàn tất.</small></article>
        <article className={failedCount ? "ui-kpi is-danger" : "ui-kpi is-success"}><span className="ui-kpi-icon"><AppIcon name={failedCount ? "alert" : "check"} size={21} /></span><span>Thất bại / bị chặn</span><strong>{failedCount}</strong><small>Cần kiểm tra lỗi provider hoặc dữ liệu.</small></article>
        <article className={snapshot.reviewCount ? "ui-kpi is-warning" : "ui-kpi is-success"}><span className="ui-kpi-icon"><AppIcon name="content" size={21} /></span><span>Chờ duyệt</span><strong>{snapshot.reviewCount}</strong><small>Nội dung chưa đủ điều kiện xuất bản.</small></article>
      </section>

      <article className="ui-panel">
        <header className="ui-panel-header"><div><h2>Hoạt động xuất bản gần đây</h2><p>Hiển thị dữ liệu thật đã lưu trong hàng đợi publish.</p></div></header>
        {snapshot.recentActivity.length ? <div className="ui-list">{snapshot.recentActivity.map((item) => (
          <div className="ui-list-row" key={item.id}>
            <span className="ui-list-icon"><AppIcon name={item.status === "published" ? "check" : item.status === "failed" || item.status === "blocked" ? "alert" : "clock"} size={19} /></span>
            <div><strong>{item.title || providerNames[item.provider] || item.provider}</strong><p>{providerNames[item.provider] || item.provider} · {dateTime.format(item.updated_at)}{item.error_message ? ` · ${item.error_message}` : ""}</p></div>
            <span className={`ui-status ${statusTone(item.status)}`}>{statusLabel(item.status)}</span>
          </div>
        ))}</div> : <div className="ui-empty"><span className="ui-empty-icon"><AppIcon name="activity" size={22} /></span><strong>Chưa có hoạt động</strong><p>Nhật ký sẽ xuất hiện sau lần đồng bộ hoặc xuất bản đầu tiên.</p></div>}
      </article>
    </AppShell>
  );
}
