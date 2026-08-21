"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  channelDefinitions,
  channelIds,
  formatDate,
  statusLabel,
  type ChannelGroup,
  type ChannelId,
} from "./channel-data";

type ChannelCounts = {
  media: number;
  products: number;
  drafts: number;
  queued: number;
  published: number;
};

type ChannelSummary = {
  id: ChannelId;
  status: string;
  connectionId: string | null;
  connectionName: string | null;
  lastActivityAt: number | string | null;
  counts: ChannelCounts;
};

type ChannelListPayload = {
  data?: { channels: ChannelSummary[] };
  error?: { message?: string };
};

type FilterId = "all" | ChannelGroup;

const filters: { id: FilterId; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "source", label: "Nguồn dữ liệu" },
  { id: "social", label: "Mạng xã hội" },
  { id: "commerce", label: "Sàn bán hàng" },
  { id: "owned", label: "Website" },
];

const emptyCounts: ChannelCounts = { media: 0, products: 0, drafts: 0, queued: 0, published: 0 };

function normalizeSummary(value: ChannelSummary | undefined, id: ChannelId): ChannelSummary {
  return {
    id,
    status: value?.status ?? (id === "zalo_personal" ? "assisted" : "disconnected"),
    connectionId: value?.connectionId ?? null,
    connectionName: value?.connectionName ?? null,
    lastActivityAt: value?.lastActivityAt ?? null,
    counts: { ...emptyCounts, ...(value?.counts ?? {}) },
  };
}

export function ChannelHub() {
  const [summaries, setSummaries] = useState<Map<ChannelId, ChannelSummary>>(() => new Map());
  const [filter, setFilter] = useState<FilterId>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadChannels = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/channels", { headers: { accept: "application/json" } });
      const payload = await response.json() as ChannelListPayload;
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message || "Không thể tải dữ liệu từng kênh.");
      }
      setSummaries(new Map(payload.data.channels.map((channel) => [channel.id, channel])));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Không thể tải dữ liệu từng kênh.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void loadChannels(), 0);
    return () => window.clearTimeout(task);
  }, [loadChannels]);

  const visibleIds = channelIds.filter((id) => filter === "all" || channelDefinitions[id].group === filter);
  const connectedCount = channelIds.reduce((total, id) => {
    const status = summaries.get(id)?.status;
    return total + (status === "connected" || status === "assisted" ? 1 : 0);
  }, 0);

  return (
    <main className="ch-page">
      <header className="ch-topbar">
        <Link className="ch-brand" href="/" aria-label="TAHA AI - Về tổng quan">
          <span className="ch-brand-mark" aria-hidden="true">TA</span>
          <span><strong>TAHA AI</strong><small>Channel workspace</small></span>
        </Link>
        <nav className="ch-main-nav" aria-label="Điều hướng chính">
          <Link href="/">Tổng quan</Link>
          <Link className="is-current" href="/channels" aria-current="page">Từng kênh</Link>
          <Link href="/connections">Kết nối tài khoản</Link>
        </nav>
        <button
          className="ch-icon-button"
          type="button"
          onClick={() => void loadChannels(true)}
          disabled={refreshing}
          aria-label="Làm mới dữ liệu kênh"
        >
          <span aria-hidden="true">↻</span>
          <span>{refreshing ? "Đang tải" : "Làm mới"}</span>
        </button>
      </header>

      <section className="ch-hero">
        <div className="ch-hero-copy">
          <span className="ch-eyebrow">KHÔNG GIAN NỘI DUNG ĐA KÊNH</span>
          <h1>Mỗi kênh, một kho nội dung riêng.</h1>
          <p>Ảnh nguồn, dữ liệu sản phẩm, bài viết và lịch sử đăng được tách rõ để bạn biết chính xác nội dung nào đang nằm ở đâu.</p>
        </div>
        <div className="ch-health-card" aria-label={`${connectedCount} trên 7 kênh sẵn sàng`}>
          <div><span className="ch-live-dot" /><strong>{connectedCount}/7</strong></div>
          <p>Kênh sẵn sàng</p>
          <Link href="/connections">Thiết lập kết nối <span aria-hidden="true">→</span></Link>
        </div>
      </section>

      <section className="ch-content-section" aria-labelledby="channel-list-title">
        <div className="ch-section-heading">
          <div>
            <span className="ch-eyebrow">KHO LÀM VIỆC</span>
            <h2 id="channel-list-title">Chọn kênh để quản lý</h2>
          </div>
          <div className="ch-filter" role="group" aria-label="Lọc loại kênh">
            {filters.map((item) => (
              <button
                type="button"
                key={item.id}
                className={filter === item.id ? "is-active" : ""}
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <div className="ch-state-card ch-error-state" role="alert">
            <span aria-hidden="true">!</span>
            <div><strong>Chưa tải được kho kênh</strong><p>{error}</p></div>
            <button type="button" onClick={() => void loadChannels()}>Thử lại</button>
          </div>
        ) : null}

        {loading ? (
          <div className="ch-card-grid" aria-label="Đang tải các kênh" aria-busy="true">
            {[0, 1, 2, 3].map((item) => <div className="ch-channel-card ch-skeleton" key={item}><i /><i /><i /></div>)}
          </div>
        ) : visibleIds.length === 0 ? (
          <div className="ch-state-card"><span aria-hidden="true">○</span><div><strong>Không có kênh trong nhóm này</strong><p>Chọn một nhóm khác để tiếp tục.</p></div></div>
        ) : (
          <div className="ch-card-grid">
            {visibleIds.map((id) => {
              const definition = channelDefinitions[id];
              const channel = normalizeSummary(summaries.get(id), id);
              const available = channel.status === "connected" || channel.status === "assisted";
              return (
                <article className="ch-channel-card" key={id}>
                  <div className="ch-card-topline">
                    <span className="ch-channel-mark" style={{ background: definition.softAccent, color: definition.accent }}>{definition.mark}</span>
                    <span className={`ch-status ch-status-${channel.status}`}><i />{statusLabel(channel.status)}</span>
                  </div>
                  <div className="ch-card-copy">
                    <span>{definition.eyebrow}</span>
                    <h3>{definition.name}</h3>
                    <p>{definition.description}</p>
                  </div>
                  <dl className="ch-card-metrics">
                    <div><dt>{id === "google_sheets" ? "Sản phẩm" : "Hình ảnh"}</dt><dd>{id === "google_sheets" ? channel.counts.products : channel.counts.media}</dd></div>
                    <div><dt>Bản nháp</dt><dd>{channel.counts.drafts}</dd></div>
                    <div><dt>{id.startsWith("google_") ? "Đã đồng bộ" : "Đã đăng"}</dt><dd>{channel.counts.published}</dd></div>
                  </dl>
                  <div className="ch-card-footer">
                    <div><span className={available ? "is-live" : ""} />{channel.connectionName || formatDate(channel.lastActivityAt)}</div>
                    <Link href={`/channels/${id}`}>Mở kho <span aria-hidden="true">→</span></Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="ch-flow-note" aria-label="Cách dữ liệu di chuyển">
        <div><span>01</span><strong>Drive giữ ảnh gốc</strong><p>Mọi tài sản hình ảnh bắt đầu tại một kho nguồn rõ ràng.</p></div>
        <div><span>02</span><strong>Sheets giữ dữ liệu</strong><p>SKU, giá và mô tả được đồng bộ mà không trộn với bài viết.</p></div>
        <div><span>03</span><strong>Mỗi kênh có bản riêng</strong><p>Caption và hình ảnh đã chỉnh được lưu theo đúng nền tảng đích.</p></div>
      </section>
    </main>
  );
}
