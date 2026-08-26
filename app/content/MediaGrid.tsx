"use client";

import { useState } from "react";
import Link from "../SiteLink";
import { AppIcon } from "../ui/AppIcon";

type MediaItem = {
  id: string;
  mediaType: string;
  origin: string;
  filename: string;
  status: string;
  previewUrl: string;
  downloadUrl: string;
  updatedAt: string | null;
};

const originLabels: Record<string, string> = {
  source: "Ảnh gốc",
  generated: "Ảnh AI",
  uploaded: "Tải lên",
  derived: "Biến thể",
};

export function MediaGrid({ media }: { media: MediaItem[] }) {
  const [failed, setFailed] = useState<Set<string>>(() => new Set());

  return (
    <div className="ui-media-grid">
      {media.map((item) => (
        <article className="ui-media-card" key={item.id}>
          <Link className="ui-media-thumb" href={item.downloadUrl} aria-label={`Mở ${item.filename}`}>
            {item.mediaType === "image" && !failed.has(item.id)
              ? <img src={item.previewUrl} alt={item.filename} loading="lazy" onError={() => setFailed((current) => new Set(current).add(item.id))} />
              : <span><AppIcon name={item.mediaType === "image" ? "image" : "content"} size={25} /></span>}
          </Link>
          <div className="ui-media-copy">
            <strong title={item.filename}>{item.filename}</strong>
            <span>{originLabels[item.origin] || item.origin}</span>
            <small className={`ui-status ${item.status === "ready" ? "is-success" : item.status === "failed" ? "is-danger" : "is-warning"}`}>{item.status === "ready" ? "Sẵn sàng" : item.status === "failed" ? "Có lỗi" : "Đang xử lý"}</small>
          </div>
        </article>
      ))}
    </div>
  );
}
