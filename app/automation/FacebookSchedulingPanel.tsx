"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";

type Plan = { date: string; times: string[]; updatedAt: number };
type RepostProduct = { id: string; sku: string; name: string; lastPublishedAt: number };

const suggestedTimes = ["08:00", "12:00", "18:00", "20:00", "09:30", "14:30", "16:30", "21:30"];

function vietnamDate(offsetDays = 0) {
  const shifted = new Date(Date.now() + 7 * 60 * 60 * 1_000 + offsetDays * 24 * 60 * 60 * 1_000);
  return shifted.toISOString().slice(0, 10);
}

function messageFrom(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return fallback;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : fallback;
}

async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, headers: { accept: "application/json", ...init?.headers } });
  const payload = await response.json().catch(() => ({})) as { data?: Record<string, unknown> };
  if (!response.ok) throw new Error(messageFrom(payload, "Yêu cầu chưa được xử lý."));
  return payload.data ?? {};
}

function nextSuggestedTime(current: string[]) {
  const suggested = suggestedTimes.find((time) => !current.includes(time));
  if (suggested) return suggested;
  for (let hour = 0; hour < 24; hour += 1) {
    const candidate = `${String(hour).padStart(2, "0")}:00`;
    if (!current.includes(candidate)) return candidate;
  }
  return "23:59";
}

export default function FacebookSchedulingPanel() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [planDate, setPlanDate] = useState(vietnamDate(1));
  const [postCount, setPostCount] = useState(1);
  const [times, setTimes] = useState(["08:00"]);
  const [products, setProducts] = useState<RepostProduct[]>([]);
  const [repostProductId, setRepostProductId] = useState("");
  const [repostDate, setRepostDate] = useState(vietnamDate(1));
  const [repostTime, setRepostTime] = useState("08:00");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<"save" | "repost" | null>(null);
  const [isPending, startTransition] = useTransition();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [planData, repostData] = await Promise.all([
        api("/api/automation/facebook-schedule"),
        api("/api/automation/facebook-repost"),
      ]);
      const loadedPlans = Array.isArray(planData.plans) ? planData.plans as Plan[] : [];
      const loadedProducts = Array.isArray(repostData.products) ? repostData.products as RepostProduct[] : [];
      setPlans(loadedPlans);
      setProducts(loadedProducts);
      setRepostProductId((current) => current || loadedProducts[0]?.id || "");
      const existing = loadedPlans.find((plan) => plan.date === planDate);
      if (existing) {
        setPostCount(existing.times.length);
        setTimes(existing.times);
      }
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Không thể tải lịch Facebook.");
    } finally {
      setLoading(false);
    }
  }, [planDate]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selectedRepost = useMemo(
    () => products.find((product) => product.id === repostProductId) ?? null,
    [products, repostProductId],
  );

  function changePlanDate(date: string) {
    setPlanDate(date);
    const existing = plans.find((plan) => plan.date === date);
    const nextTimes = existing?.times ?? ["08:00"];
    setPostCount(nextTimes.length);
    setTimes(nextTimes);
  }

  function changePostCount(value: string) {
    const count = Math.max(1, Math.min(24, Number(value) || 1));
    setPostCount(count);
    setTimes((current) => {
      const next = current.slice(0, count);
      while (next.length < count) next.push(nextSuggestedTime(next));
      return next;
    });
  }

  function savePlan() {
    setNotice("");
    setError("");
    setBusyAction("save");
    startTransition(async () => {
      try {
        const data = await api("/api/automation/facebook-schedule", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ date: planDate, postCount, times }),
        });
        setPlans(Array.isArray(data.plans) ? data.plans as Plan[] : plans);
        setNotice(`Đã lưu ${postCount} bài Facebook ngày ${planDate} vào ${times.join(", ")}.`);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : "Không thể lưu lịch Facebook.");
      } finally {
        setBusyAction(null);
      }
    });
  }

  function scheduleRepost() {
    if (!repostProductId) return;
    setNotice("");
    setError("");
    setBusyAction("repost");
    startTransition(async () => {
      try {
        const data = await api("/api/automation/facebook-repost", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ productId: repostProductId, date: repostDate, time: repostTime }),
        });
        setNotice(data.replayed
          ? `Lịch đăng lại ${selectedRepost?.sku ?? "sản phẩm"} đã tồn tại; hệ thống không tạo trùng.`
          : `Đã lên lịch đăng lại ${selectedRepost?.sku ?? "sản phẩm"} lúc ${repostTime} ngày ${repostDate}.`);
      } catch (repostError) {
        setError(repostError instanceof Error ? repostError.message : "Không thể lên lịch đăng lại.");
      } finally {
        setBusyAction(null);
      }
    });
  }

  return (
    <section className="automation-facebook-admin" aria-labelledby="facebook-schedule-title">
      <div className="automation-card-title">
        <div><span>FB</span><h2 id="facebook-schedule-title">Lịch đăng Facebook của Admin</h2></div>
        <small>Múi giờ Việt Nam · tự động đăng đúng lịch</small>
      </div>
      {notice ? <div className="automation-alert is-success" role="status">✓ {notice}</div> : null}
      {error ? <div className="automation-alert is-error" role="alert">! {error}</div> : null}

      <div className="facebook-admin-grid">
        <section className="facebook-admin-box">
          <div className="facebook-admin-box-heading">
            <div><strong>Cài số bài theo ngày</strong><span>Mỗi bài tương ứng một khung giờ riêng</span></div>
          </div>
          <div className="facebook-plan-fields">
            <label><span>Ngày đăng</span><input type="date" min={vietnamDate()} value={planDate} onChange={(event) => changePlanDate(event.target.value)} /></label>
            <label><span>Số lượng bài</span><input type="number" min="1" max="24" value={postCount} onChange={(event) => changePostCount(event.target.value)} /></label>
          </div>
          <div className="facebook-time-grid">
            {times.map((time, index) => (
              <label key={index}><span>Bài {index + 1}</span><input type="time" value={time} onChange={(event) => setTimes((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} /></label>
            ))}
          </div>
          <p className="facebook-repost-note">Nếu chọn hôm nay, mỗi giờ đăng cần cách hiện tại ít nhất 30 phút để hệ thống chuẩn bị nội dung và toàn bộ ảnh đúng SKU.</p>
          <button className="facebook-primary-button" type="button" aria-busy={busyAction === "save"} onClick={savePlan} disabled={loading || isPending || busyAction !== null || times.some((time) => !time)}>{busyAction === "save" ? "Đang lưu lịch…" : "Lưu lịch đăng"}</button>
          {plans.length ? <div className="facebook-saved-plans">
            <strong>Lịch đã lưu</strong>
            {plans.slice(0, 8).map((plan) => <button type="button" key={plan.date} onClick={() => changePlanDate(plan.date)}><span>{plan.date}</span><b>{plan.times.length} bài</b><small>{plan.times.join(" · ")}</small></button>)}
          </div> : null}
        </section>

        <section className="facebook-admin-box">
          <div className="facebook-admin-box-heading">
            <div><strong>Đăng lại bài Facebook</strong><span>Chỉ hiển thị sản phẩm đã đăng thành công</span></div>
          </div>
          {products.length ? <>
            <label className="facebook-wide-field"><span>Sản phẩm đã đăng</span><select value={repostProductId} onChange={(event) => setRepostProductId(event.target.value)}>{products.map((product) => <option key={product.id} value={product.id}>{product.sku} — {product.name}</option>)}</select></label>
            <div className="facebook-plan-fields">
              <label><span>Ngày đăng lại</span><input type="date" min={vietnamDate()} value={repostDate} onChange={(event) => setRepostDate(event.target.value)} /></label>
              <label><span>Giờ đăng lại</span><input type="time" value={repostTime} onChange={(event) => setRepostTime(event.target.value)} /></label>
            </div>
            <p className="facebook-repost-note">Dùng lại nội dung và toàn bộ ảnh của lần đăng Facebook thành công gần nhất; không tạo ảnh hoặc viết lại bài.</p>
            <button className="facebook-primary-button is-repost" type="button" aria-busy={busyAction === "repost"} onClick={scheduleRepost} disabled={loading || isPending || busyAction !== null || !repostProductId || !repostTime}>{busyAction === "repost" ? "Đang lên lịch…" : "Đăng lại theo lịch"}</button>
          </> : <div className="automation-empty"><strong>Chưa có bài đủ điều kiện đăng lại</strong><span>Sản phẩm sẽ xuất hiện tại đây sau khi Facebook xác nhận đăng thành công.</span></div>}
        </section>
      </div>
    </section>
  );
}
