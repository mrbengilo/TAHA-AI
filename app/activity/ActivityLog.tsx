"use client";

import { useMemo, useState } from "react";
import type { PublishingActivityEntry, PublishingProvider } from "../../lib/publishing-history";
import Link from "../SiteLink";
import { AppIcon } from "../ui/AppIcon";

const PUBLISHING_PROVIDERS: readonly PublishingProvider[] = [
  "facebook", "website", "zalo_personal", "shopee", "tiktok_shop",
];

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

const dayLabel = new Intl.DateTimeFormat("vi-VN", { dateStyle: "full", timeZone: "Asia/Ho_Chi_Minh" });
const timeLabel = new Intl.DateTimeFormat("vi-VN", {
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Ho_Chi_Minh",
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

type ActivityLogProps = {
  activity: PublishingActivityEntry[];
  initialProvider: PublishingProvider;
};

export default function ActivityLog({ activity, initialProvider }: ActivityLogProps) {
  const [selectedProvider, setSelectedProvider] = useState(initialProvider);
  const providerViews = useMemo(() => {
    const entries = new Map(PUBLISHING_PROVIDERS.map((provider) => [provider, [] as PublishingActivityEntry[]]));
    for (const item of activity) entries.get(item.provider)!.push(item);
    return new Map(PUBLISHING_PROVIDERS.map((provider) => {
      const providerEntries = entries.get(provider)!;
      const groups = new Map<string, PublishingActivityEntry[]>();
      let successCount = 0;
      let failedCount = 0;
      let waitingCount = 0;
      for (const entry of providerEntries) {
        if (entry.status === "published") successCount += 1;
        else if (entry.status === "failed" || entry.status === "blocked") failedCount += 1;
        else if (["queued", "publishing", "retry_wait", "awaiting_confirmation"].includes(entry.status)) waitingCount += 1;
        const key = vietnamDayKey(activityTimestamp(entry));
        const current = groups.get(key) ?? [];
        current.push(entry);
        groups.set(key, current);
      }
      return [provider, {
        entries: providerEntries,
        days: [...groups].map(([date, dayEntries]) => ({ date, entries: dayEntries })),
        successCount,
        failedCount,
        waitingCount,
      }] as const;
    }));
  }, [activity]);
  const selectedView = providerViews.get(selectedProvider)!;

  function selectProvider(provider: PublishingProvider) {
    if (provider === selectedProvider) return;
    setSelectedProvider(provider);
    const url = new URL(window.location.href);
    url.searchParams.set("channel", provider);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  return (
    <>
      <section className="ui-kpi-grid" aria-label="Tổng quan hoạt động">
        <article className="ui-kpi"><span className="ui-kpi-icon"><AppIcon name="activity" size={21} /></span><span>Bài của {providerNames[selectedProvider]}</span><strong>{selectedView.entries.length}</strong><small>Toàn bộ dữ liệu đã lưu, không giới hạn 5 bài.</small></article>
        <article className="ui-kpi is-success"><span className="ui-kpi-icon"><AppIcon name="check" size={21} /></span><span>Đã đăng</span><strong>{selectedView.successCount}</strong><small>Provider đã xác nhận hoàn tất.</small></article>
        <article className={selectedView.waitingCount ? "ui-kpi is-warning" : "ui-kpi is-success"}><span className="ui-kpi-icon"><AppIcon name="clock" size={21} /></span><span>Đang chờ / xử lý</span><strong>{selectedView.waitingCount}</strong><small>Chờ giờ đăng, đang đăng, retry hoặc xác nhận.</small></article>
        <article className={selectedView.failedCount ? "ui-kpi is-danger" : "ui-kpi is-success"}><span className="ui-kpi-icon"><AppIcon name={selectedView.failedCount ? "alert" : "check"} size={21} /></span><span>Thất bại / bị chặn</span><strong>{selectedView.failedCount}</strong><small>Cần kiểm tra lỗi provider hoặc dữ liệu.</small></article>
      </section>

      <article className="ui-panel">
        <div className="activity-channel-tabs" aria-label="Lọc nhật ký theo kênh" role="tablist">
          {PUBLISHING_PROVIDERS.map((provider) => {
            const count = providerViews.get(provider)!.entries.length;
            const selected = selectedProvider === provider;
            return <button
              className={`activity-channel-tab ${provider}${selected ? " is-active" : ""}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="activity-channel-panel"
              tabIndex={selected ? 0 : -1}
              onClick={() => selectProvider(provider)}
              key={provider}
            ><span className={`ui-provider-badge ${provider}`}>{providerMarks[provider]}</span><strong>{providerNames[provider]}</strong><b>{count}</b></button>;
          })}
        </div>
        <div className="activity-channel-panel" id="activity-channel-panel" role="tabpanel" key={selectedProvider}>
          <header className="ui-panel-header activity-log-heading"><div><h2>Lịch sử {providerNames[selectedProvider]}</h2><p>{selectedView.days.length} ngày · {selectedView.entries.length} bài · hiển thị đầy đủ theo thời gian mới nhất.</p></div></header>
          {selectedView.days.length ? <div className="publication-activity">{selectedView.days.map((day) => (
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
        </div>
      </article>
    </>
  );
}
