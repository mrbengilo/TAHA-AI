"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import Link from "../SiteLink";

type Product = { id: string; name: string; sku: string; status: string; updatedAt: string };
type AutomationRun = {
  id: string;
  productId: string;
  sourceMediaId: string;
  status: string;
  requestedImageCount: number;
  completedImageCount: number;
  targetProviders: string[];
  outputMediaIds: string[];
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  completedAt: number | null;
};

const providerOptions = [
  { id: "facebook", name: "Facebook", mark: "f" },
  { id: "zalo_personal", name: "Zalo cá nhân", mark: "Z" },
  { id: "website", name: "Website", mark: "W" },
  { id: "tiktok_shop", name: "TikTok Shop", mark: "T" },
  { id: "shopee", name: "Shopee", mark: "S" },
] as const;

const statusLabels: Record<string, string> = {
  queued: "Đang chờ",
  processing: "Đang tạo nội dung",
  completed: "Đã hoàn tất",
  failed: "Cần kiểm tra",
  cancelled: "Đã hủy",
};

function errorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const root = payload as { error?: { message?: unknown } };
  return typeof root.error?.message === "string" ? root.error.message : fallback;
}

async function loadJson(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, headers: { accept: "application/json", ...init?.headers } });
  const payload = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) throw new Error(errorMessage(payload, "Yêu cầu chưa được xử lý."));
  return payload as { data?: Record<string, unknown> };
}

function formatDate(value: number) {
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date(value));
}

export default function AutomationCenter() {
  const [products, setProducts] = useState<Product[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [targets, setTargets] = useState<string[]>(providerOptions.map((item) => item.id));
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tiktokCategoryId, setTikTokCategoryId] = useState("");
  const [tiktokWarehouseId, setTikTokWarehouseId] = useState("");
  const [tiktokWeight, setTikTokWeight] = useState("500");
  const [tiktokSalesAttributes, setTikTokSalesAttributes] = useState("");
  const [isPending, startTransition] = useTransition();

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [productPayload, runPayload] = await Promise.all([
        loadJson("/api/channels/google_sheets?limit=100"),
        loadJson("/api/automation-runs?limit=30"),
      ]);
      const productRows = Array.isArray(productPayload.data?.products) ? productPayload.data.products : [];
      const runRows = Array.isArray(runPayload.data?.runs) ? runPayload.data.runs : [];
      const normalizedProducts = productRows.flatMap((item): Product[] => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        if (typeof row.id !== "string") return [];
        return [{
          id: row.id,
          name: typeof row.name === "string" ? row.name : "Sản phẩm chưa đặt tên",
          sku: typeof row.baseSku === "string"
            ? row.baseSku
            : typeof row.sku === "string"
              ? row.sku
              : "Chưa có SKU",
          status: typeof row.status === "string" ? row.status : "draft",
          updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "unknown",
        }];
      });
      setProducts(normalizedProducts);
      setRuns(runRows as AutomationRun[]);
      setSelectedProductId((current) => current || normalizedProducts[0]?.id || "");
      setError("");
    } catch (loadError) {
      if (!quiet) setError(loadError instanceof Error ? loadError.message : "Không thể tải dữ liệu AI.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "processing");
  useEffect(() => {
    if (!hasActiveRun) return undefined;
    const timer = window.setInterval(() => void refresh(true), 8_000);
    return () => window.clearInterval(timer);
  }, [hasActiveRun, refresh]);

  const selectedProduct = useMemo(
    () => products.find((product) => product.id === selectedProductId) ?? null,
    [products, selectedProductId],
  );
  const selectedHasActiveRun = runs.some(
    (run) => run.productId === selectedProductId && (run.status === "queued" || run.status === "processing"),
  );

  function toggleTarget(provider: string) {
    setTargets((current) => current.includes(provider)
      ? current.filter((item) => item !== provider)
      : [...current, provider]);
  }

  function queueRun() {
    if (!selectedProductId || targets.length === 0) return;
    setNotice("");
    setError("");
    startTransition(async () => {
      try {
        const payload = await loadJson("/api/automation-runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            productId: selectedProductId,
            imageCount: 6,
            targetProviders: targets,
            idempotencyKey: `product:${selectedProductId}:${selectedProduct?.updatedAt ?? "unknown"}:${[...targets].sort().join(",")}:ai-v1`,
          }),
        });
        const run = payload.data?.run as AutomationRun | undefined;
        setNotice(run ? `Đã đưa SKU ${selectedProduct?.sku ?? ""} vào hàng đợi AI.` : "Đã tạo công việc AI.");
        await refresh(true);
      } catch (queueError) {
        setError(queueError instanceof Error ? queueError.message : "Không thể chạy AI.");
      }
    });
  }

  function cancelRun(runId: string) {
    setNotice("");
    setError("");
    startTransition(async () => {
      try {
        await loadJson(`/api/automation-runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
        setNotice("Đã hủy công việc AI.");
        await refresh(true);
      } catch (cancelError) {
        setError(cancelError instanceof Error ? cancelError.message : "Không thể hủy công việc.");
      }
    });
  }

  function retryRun(runId: string) {
    setNotice("");
    setError("");
    startTransition(async () => {
      try {
        await loadJson(`/api/automation-runs/${encodeURIComponent(runId)}/retry`, { method: "POST" });
        setNotice("Đã đưa các bước chưa hoàn tất trở lại hàng đợi AI.");
        await refresh(true);
      } catch (retryError) {
        setError(retryError instanceof Error ? retryError.message : "Không thể thử lại công việc.");
      }
    });
  }

  function publishCommerce(provider: "tiktok_shop" | "shopee", productId: string) {
    setNotice("");
    setError("");
    startTransition(async () => {
      try {
        await loadJson(`/api/commerce/${provider}/products/${encodeURIComponent(productId)}/publish`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        setNotice(provider === "tiktok_shop"
          ? "Đã đưa sản phẩm vào hàng đợi TikTok Shop."
          : "Đã đưa sản phẩm vào hàng đợi Shopee.");
      } catch (publishError) {
        setError(publishError instanceof Error ? publishError.message : "Chưa thể đăng sản phẩm.");
      }
    });
  }

  function saveTikTokConfiguration() {
    if (!selectedProductId) return;
    setNotice("");
    setError("");
    startTransition(async () => {
      try {
        let salesAttributesBySku: Record<string, unknown> = {};
        if (tiktokSalesAttributes.trim()) {
          const parsed = JSON.parse(tiktokSalesAttributes) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Thuộc tính biến thể phải là một JSON object theo SKU.");
          }
          salesAttributesBySku = parsed as Record<string, unknown>;
        }
        const payload = await loadJson(
          `/api/commerce/tiktok_shop/products/${encodeURIComponent(selectedProductId)}/configuration`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              categoryId: tiktokCategoryId,
              warehouseId: tiktokWarehouseId,
              weightValue: Number(tiktokWeight),
              weightUnit: "GRAM",
              salesAttributesBySku,
              saveMode: "AS_DRAFT",
            }),
          },
        );
        setNotice(payload.data?.ready
          ? "Cấu hình TikTok đã đầy đủ; có thể bấm Đăng TikTok."
          : "Đã lưu cấu hình TikTok; hệ thống vẫn còn hiển thị mục cần bổ sung khi bấm đăng.");
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : "Không thể lưu cấu hình TikTok.");
      }
    });
  }

  return (
    <section className="automation-content" aria-labelledby="automation-title">
      <div className="automation-heading">
        <div>
          <span className="automation-eyebrow">TRUNG TÂM NỘI DUNG TỰ ĐỘNG</span>
          <h1 id="automation-title">Tạo bộ nội dung sản phẩm bằng AI</h1>
          <p>Đối chiếu SKU từ Google Sheets với ảnh gốc trên Drive, tạo 6 bố cục, nội dung riêng và lịch đăng cho từng kênh.</p>
        </div>
        <button className="automation-refresh" type="button" onClick={() => void refresh()} disabled={loading || isPending}>↻ Làm mới</button>
      </div>

      {notice ? <div className="automation-alert is-success" role="status">✓ {notice}</div> : null}
      {error ? <div className="automation-alert is-error" role="alert">! {error}</div> : null}

      <div className="automation-grid">
        <section className="automation-card automation-builder">
          <div className="automation-card-title">
            <div><span>01</span><h2>Chọn sản phẩm</h2></div>
            <small>Dữ liệu từ Google Sheets</small>
          </div>
          {loading ? <p className="automation-empty">Đang tải sản phẩm…</p> : products.length ? (
            <label className="automation-field">
              <span>Sản phẩm / SKU</span>
              <select value={selectedProductId} onChange={(event) => setSelectedProductId(event.target.value)}>
                {products.map((product) => <option value={product.id} key={product.id}>{product.sku} — {product.name}</option>)}
              </select>
            </label>
          ) : (
            <div className="automation-empty">
              <strong>Chưa có sản phẩm</strong>
              <span>Hãy đồng bộ Google Sheets trước khi chạy AI.</span>
              <Link href="/channels/google_sheets">Mở Google Sheets →</Link>
            </div>
          )}

          <div className="automation-card-title automation-step-two">
            <div><span>02</span><h2>Chọn kênh đầu ra</h2></div>
            <small>5 bộ nội dung riêng</small>
          </div>
          <div className="automation-targets">
            {providerOptions.map((provider) => {
              const selected = targets.includes(provider.id);
              return (
                <label className={selected ? "is-selected" : ""} key={provider.id}>
                  <input type="checkbox" checked={selected} onChange={() => toggleTarget(provider.id)} />
                  <i>{provider.mark}</i><span>{provider.name}</span><b>{selected ? "✓" : "+"}</b>
                </label>
              );
            })}
          </div>

          <div className="automation-output-preview">
            <div><b>6</b><span>ảnh bố cục mới</span></div>
            <div><b>{targets.length}</b><span>bộ nội dung</span></div>
            <div><b>1</b><span>lịch tự động / kênh</span></div>
          </div>
          <button
            className="automation-run-button"
            type="button"
            onClick={queueRun}
            disabled={!selectedProductId || targets.length === 0 || selectedHasActiveRun || loading || isPending}
          >
            {isPending
              ? "Đang xử lý…"
              : selectedHasActiveRun
                ? "SKU này đang được xử lý"
                : "✦ Tạo 6 ảnh và nội dung tự động"}
          </button>
          <p className="automation-safety">AI giữ nguyên nhận diện sản phẩm; ảnh và nội dung được lưu theo SKU. Zalo cá nhân luôn cần bạn xác nhận đăng.</p>
        </section>

        <aside className="automation-card automation-flow">
          <div className="automation-card-title"><div><span>✓</span><h2>Quy trình hệ thống</h2></div></div>
          <ol>
            <li><i>1</i><div><strong>Đọc Google Sheets</strong><span>Tên, SKU, mô tả, giá và tồn kho</span></div></li>
            <li><i>2</i><div><strong>Ghép ảnh Google Drive</strong><span>Thư mục hoặc tên file chứa đúng SKU</span></div></li>
            <li><i>3</i><div><strong>Tạo 6 bố cục ảnh</strong><span>Lưu R2 và ghi trả về thư mục Drive gốc</span></div></li>
            <li><i>4</i><div><strong>Viết nội dung đa kênh</strong><span>Bài viết, mô tả và hashtag tiếng Việt</span></div></li>
            <li><i>5</i><div><strong>Lên lịch và xuất bản</strong><span>Facebook, Zalo, Website; sàn dùng nút đăng</span></div></li>
          </ol>
          <Link className="automation-guide" href="/connections/guide">Cấu hình nguồn dữ liệu →</Link>
        </aside>
      </div>

      <section className="automation-card automation-commerce-config">
        <div className="automation-card-title">
          <div><span>03</span><h2>Cấu hình listing TikTok Shop</h2></div>
          <small>Lưu dạng nháp an toàn trước khi gửi sàn</small>
        </div>
        <div className="automation-config-grid">
          <label><span>Category ID</span><input value={tiktokCategoryId} onChange={(event) => setTikTokCategoryId(event.target.value)} placeholder="Danh mục TikTok đã được duyệt" /></label>
          <label><span>Warehouse ID</span><input value={tiktokWarehouseId} onChange={(event) => setTikTokWarehouseId(event.target.value)} placeholder="Kho hàng TikTok Shop" /></label>
          <label><span>Khối lượng (gram)</span><input inputMode="decimal" value={tiktokWeight} onChange={(event) => setTikTokWeight(event.target.value)} /></label>
          <label className="is-wide"><span>Thuộc tính biến thể theo SKU (JSON, chỉ cần khi có nhiều size/màu)</span><textarea value={tiktokSalesAttributes} onChange={(event) => setTikTokSalesAttributes(event.target.value)} placeholder={'{"SKU-38":[{"id":"...","value_id":"..."}]}'}/></label>
        </div>
        <div className="automation-config-actions">
          <p>TikTok bắt buộc Category ID, Warehouse ID và thuộc tính biến thể do Seller Center cấp; AI không tự bịa các mã này.</p>
          <button type="button" onClick={saveTikTokConfiguration} disabled={!selectedProductId || !tiktokCategoryId.trim() || !tiktokWarehouseId.trim() || isPending}>Lưu cấu hình TikTok</button>
        </div>
      </section>

      <section className="automation-card automation-runs">
        <div className="automation-card-title">
          <div><span>⌁</span><h2>Tiến độ gần đây</h2></div>
          <small>{runs.length} công việc</small>
        </div>
        {runs.length ? <div className="automation-run-list">
          {runs.map((run) => {
            const product = products.find((item) => item.id === run.productId);
            const progress = Math.round((run.completedImageCount / Math.max(1, run.requestedImageCount)) * 100);
            const active = run.status === "queued" || run.status === "processing";
            return (
              <article key={run.id}>
                <div className={`automation-run-status is-${run.status}`}><i>{run.status === "completed" ? "✓" : active ? "✦" : "!"}</i></div>
                <div className="automation-run-info">
                  <div><strong>{product?.sku ?? "SKU"} · {product?.name ?? "Sản phẩm"}</strong><span>{formatDate(run.createdAt)}</span></div>
                  <p>{statusLabels[run.status] ?? run.status} · {run.completedImageCount}/{run.requestedImageCount} ảnh</p>
                  <div className="automation-progress"><i style={{ width: `${progress}%` }} /></div>
                  {run.errorCode ? <small>{run.errorMessage || run.errorCode}</small> : null}
                </div>
                <div className="automation-run-actions">
                  {active ? <button type="button" onClick={() => cancelRun(run.id)} disabled={isPending}>Hủy</button> : null}
                  {run.status === "failed" || run.status === "cancelled"
                    ? <button type="button" onClick={() => retryRun(run.id)} disabled={isPending}>Thử lại</button>
                    : null}
                  {run.status === "completed" ? (
                    <>
                      <button type="button" onClick={() => publishCommerce("tiktok_shop", run.productId)} disabled={isPending}>Đăng TikTok</button>
                      <button type="button" onClick={() => publishCommerce("shopee", run.productId)} disabled={isPending}>Đăng Shopee</button>
                    </>
                  ) : null}
                  <Link href={`/channels/google_drive`}>Xem media</Link>
                </div>
              </article>
            );
          })}
        </div> : <div className="automation-empty is-wide"><strong>Chưa có công việc AI</strong><span>Chọn một SKU ở trên để tạo bộ nội dung đầu tiên.</span></div>}
      </section>
    </section>
  );
}
