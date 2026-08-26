"use client";

import { useMemo, useState } from "react";
import Link from "../SiteLink";
import { AppIcon } from "../ui/AppIcon";

type ProductRow = {
  id: string;
  name: string;
  baseSku: string;
  status: string;
  previewUrl: string | null;
  updatedAt: string | null;
};

type FilterId = "all" | "active" | "missing_media" | "draft" | "paused";

const filters: { id: FilterId; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "active", label: "Đang hoạt động" },
  { id: "missing_media", label: "Thiếu hình ảnh" },
  { id: "draft", label: "Bản nháp" },
  { id: "paused", label: "Tạm dừng" },
];

const statusLabels: Record<string, string> = {
  active: "Đang hoạt động",
  draft: "Bản nháp",
  paused: "Tạm dừng",
  archived: "Đã lưu trữ",
};

function statusTone(status: string) {
  if (status === "active") return "is-success";
  if (status === "paused") return "is-warning";
  return "is-info";
}

function ProductThumbnail({ product, failed, onError }: { product: ProductRow; failed: boolean; onError: () => void }) {
  return (
    <span className="ui-product-thumb">
      {product.previewUrl && !failed
        ? <img src={product.previewUrl} alt={`Ảnh sản phẩm ${product.baseSku}`} loading="lazy" onError={onError} />
        : <AppIcon name="image" size={20} />}
    </span>
  );
}

export function ProductsView({ products }: { products: ProductRow[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterId>("all");
  const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set());

  const visibleProducts = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("vi-VN");
    return products.filter((product) => {
      const matchesQuery = !normalizedQuery
        || product.baseSku.toLocaleLowerCase("vi-VN").includes(normalizedQuery)
        || product.name.toLocaleLowerCase("vi-VN").includes(normalizedQuery);
      if (!matchesQuery) return false;
      if (filter === "all") return true;
      if (filter === "missing_media") return !product.previewUrl || failedImages.has(product.id);
      return product.status === filter;
    });
  }, [failedImages, filter, products, query]);

  function markImageFailed(id: string) {
    setFailedImages((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }

  return (
    <>
      <div className="ui-toolbar">
        <label className="ui-search">
          <AppIcon name="search" size={18} />
          <input
            aria-label="Tìm sản phẩm theo SKU hoặc tên"
            placeholder="Tìm SKU hoặc tên sản phẩm…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="ui-filter-group" role="group" aria-label="Lọc sản phẩm">
          {filters.map((item) => (
            <button
              className={filter === item.id ? "is-active" : ""}
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {visibleProducts.length ? (
        <>
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead>
                <tr>
                  <th>Sản phẩm</th>
                  <th>Dữ liệu</th>
                  <th>Hình ảnh</th>
                  <th>Trạng thái</th>
                  <th aria-label="Hành động" />
                </tr>
              </thead>
              <tbody>
                {visibleProducts.map((product) => {
                  const imageMissing = !product.previewUrl || failedImages.has(product.id);
                  return (
                    <tr key={product.id}>
                      <td>
                        <div className="ui-product-cell">
                          <ProductThumbnail product={product} failed={failedImages.has(product.id)} onError={() => markImageFailed(product.id)} />
                          <div><strong>{product.name}</strong><small>SKU {product.baseSku}</small></div>
                        </div>
                      </td>
                      <td><span className="ui-status is-success">Đã đồng bộ</span></td>
                      <td><span className={`ui-status ${imageMissing ? "is-warning" : "is-success"}`}>{imageMissing ? "Thiếu ảnh" : "Có hình ảnh"}</span></td>
                      <td><span className={`ui-status ${statusTone(product.status)}`}>{statusLabels[product.status] || product.status}</span></td>
                      <td>
                        <div className="ui-table-actions">
                          <Link href="/channels/google_sheets">Xem</Link>
                          <Link href="/automation">Tạo AI</Link>
                          <Link href="/automation">Đăng sản phẩm</Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="ui-mobile-cards">
            {visibleProducts.map((product) => {
              const imageMissing = !product.previewUrl || failedImages.has(product.id);
              return (
                <article className="ui-product-card" key={product.id}>
                  <div className="ui-product-card-header">
                    <ProductThumbnail product={product} failed={failedImages.has(product.id)} onError={() => markImageFailed(product.id)} />
                    <div><strong>{product.name}</strong><small>SKU {product.baseSku}</small></div>
                    <span className={`ui-status ${statusTone(product.status)}`}>{statusLabels[product.status] || product.status}</span>
                  </div>
                  <div className="ui-product-card-meta">
                    <span><b>Dữ liệu</b><small>Đã đồng bộ</small></span>
                    <span><b>Hình ảnh</b><small>{imageMissing ? "Thiếu ảnh" : "Sẵn sàng"}</small></span>
                  </div>
                  <div className="ui-inline-actions">
                    <Link className="ui-button" href="/automation">Tạo AI</Link>
                    <Link className="ui-button is-primary" href="/automation">Đăng sản phẩm</Link>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      ) : (
        <div className="ui-panel">
          <div className="ui-empty">
            <span className="ui-empty-icon"><AppIcon name="search" size={22} /></span>
            <strong>Không tìm thấy sản phẩm phù hợp</strong>
            <p>Thử thay đổi từ khóa hoặc chọn một bộ lọc khác.</p>
          </div>
        </div>
      )}
    </>
  );
}
