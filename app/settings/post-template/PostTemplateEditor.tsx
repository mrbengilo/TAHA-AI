"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type SectionKey =
  | "product_name"
  | "sku"
  | "sizes"
  | "description"
  | "gifts"
  | "warranty"
  | "contact"
  | "hashtags";

type TemplateSection = {
  key: SectionKey;
  label: string;
  enabled: boolean;
  template: string;
};

type TemplateConfig = {
  schemaVersion: string;
  name: string;
  titleTemplate: string;
  introText: string;
  outroText: string;
  contactText: string;
  sections: TemplateSection[];
};

type TemplateSnapshot = {
  id: string;
  key: string;
  version: number;
  fingerprint: string;
  config: TemplateConfig;
  updatedBy: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  isDefault: boolean;
};

type Preview = { title: string; body: string };
type PreviewValues = Record<SectionKey, string>;
type RefreshResult = {
  articles: number;
  drafts: number;
  jobs: number;
  staleJobsRequeued: number;
  publishingJobsSkipped: number;
};

type LoadedData = {
  template: TemplateSnapshot;
  preview: Preview;
  previewValues: PreviewValues;
};

type SavedData = LoadedData & {
  changed: boolean;
  refresh: RefreshResult;
};

const placeholderByKey: Record<SectionKey, string> = {
  product_name: "{{product_name}}",
  sku: "{{sku}}",
  sizes: "{{sizes}}",
  description: "{{description}}",
  gifts: "{{gifts}}",
  warranty: "{{warranty}}",
  contact: "{{contact}}",
  hashtags: "{{hashtags}}",
};

function cloneConfig(config: TemplateConfig): TemplateConfig {
  return {
    ...config,
    sections: config.sections.map((section) => ({ ...section })),
  };
}

function errorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const root = payload as { error?: { message?: unknown } };
  return typeof root.error?.message === "string" ? root.error.message : fallback;
}

async function loadJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { accept: "application/json", ...init?.headers },
  });
  const payload = await response.json().catch(() => ({})) as { data?: T };
  if (!response.ok || !payload.data) {
    throw new Error(errorMessage(payload, "Yêu cầu chưa được xử lý."));
  }
  return payload.data;
}

function replacePlaceholder(template: string, key: SectionKey, value: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return template.replace(new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, "giu"), value).trim();
}

function clientPreview(config: TemplateConfig, values: PreviewValues): Preview {
  const title = config.titleTemplate
    .replace(/\{\{\s*product_name\s*\}\}/giu, values.product_name)
    .replace(/\{\{\s*sku\s*\}\}/giu, values.sku)
    .replace(/\s+/gu, " ")
    .trim();
  const blocks = [config.introText];
  for (const section of config.sections) {
    if (!section.enabled) continue;
    const value = section.key === "contact" ? config.contactText : values[section.key];
    if (!value.trim()) continue;
    blocks.push(replacePlaceholder(section.template, section.key, value));
  }
  blocks.push(config.outroText);
  return {
    title,
    body: blocks.map((block) => block.trim()).filter(Boolean).join("\n\n"),
  };
}

function formatDate(value: number | null) {
  if (!value) return "Chưa lưu tùy chỉnh";
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date(value));
}

function TemplateSkeleton() {
  return (
    <div className="post-template-loading" role="status" aria-live="polite">
      <span className="post-template-spinner" aria-hidden="true" />
      <strong>Đang tải bài viết mẫu</strong>
      <p>Hệ thống đang đọc phiên bản hiện hành và dữ liệu xem trước.</p>
    </div>
  );
}

export default function PostTemplateEditor() {
  const [snapshot, setSnapshot] = useState<TemplateSnapshot | null>(null);
  const [config, setConfig] = useState<TemplateConfig | null>(null);
  const [baseline, setBaseline] = useState<TemplateConfig | null>(null);
  const [previewValues, setPreviewValues] = useState<PreviewValues | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState<RefreshResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await loadJson<LoadedData>("/api/post-template");
      const next = cloneConfig(data.template.config);
      setSnapshot(data.template);
      setConfig(next);
      setBaseline(cloneConfig(next));
      setPreviewValues(data.previewValues);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Không thể tải bài viết mẫu.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const dirty = Boolean(config && baseline && JSON.stringify(config) !== JSON.stringify(baseline));

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (!confirming) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) setConfirming(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [confirming, saving]);

  const preview = useMemo(
    () => config && previewValues ? clientPreview(config, previewValues) : null,
    [config, previewValues],
  );

  function updateField<K extends keyof TemplateConfig>(key: K, value: TemplateConfig[K]) {
    setConfig((current) => current ? { ...current, [key]: value } : current);
    setNotice("");
    setRefresh(null);
  }

  function updateSection(index: number, patch: Partial<TemplateSection>) {
    setConfig((current) => {
      if (!current) return current;
      const sections = current.sections.map((section, currentIndex) => currentIndex === index
        ? { ...section, ...patch }
        : section);
      return { ...current, sections };
    });
    setNotice("");
    setRefresh(null);
  }

  function moveSection(index: number, direction: -1 | 1) {
    setConfig((current) => {
      if (!current) return current;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.sections.length) return current;
      const sections = current.sections.map((section) => ({ ...section }));
      [sections[index], sections[nextIndex]] = [sections[nextIndex], sections[index]];
      return { ...current, sections };
    });
    setNotice("");
    setRefresh(null);
  }

  function resetChanges() {
    if (!baseline) return;
    setConfig(cloneConfig(baseline));
    setError("");
    setNotice("Đã hoàn tác các thay đổi chưa lưu.");
    setRefresh(null);
  }

  async function save() {
    if (!snapshot || !config || !dirty || saving) return;
    setConfirming(false);
    setSaving(true);
    setError("");
    setNotice("");
    setRefresh(null);
    try {
      const data = await loadJson<SavedData>("/api/post-template", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: snapshot.version, config }),
      });
      const next = cloneConfig(data.template.config);
      setSnapshot(data.template);
      setConfig(next);
      setBaseline(cloneConfig(next));
      setPreviewValues(data.previewValues);
      setRefresh(data.refresh);
      setNotice(data.changed
        ? `Đã lưu phiên bản ${data.template.version} và cập nhật các bài chưa xuất bản theo cấu trúc mới.`
        : "Bài viết mẫu không có thay đổi mới để cập nhật.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Không thể lưu bài viết mẫu.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <TemplateSkeleton />;

  if (!snapshot || !config || !previewValues || !preview) {
    return (
      <div className="post-template-error" role="alert">
        <span aria-hidden="true">!</span>
        <div><strong>Không thể mở bài viết mẫu</strong><p>{error || "Dữ liệu trả về chưa đầy đủ."}</p></div>
        <button type="button" onClick={() => void load()}>Thử lại</button>
      </div>
    );
  }

  return (
    <div className="post-template-page">
      <section className="post-template-intro" aria-labelledby="post-template-title">
        <div>
          <span className="post-template-eyebrow">CẤU TRÚC NỘI DUNG CHUNG</span>
          <h1 id="post-template-title">Bài viết mẫu</h1>
          <p>
            Quản lý cấu trúc dùng chung cho các bài sản phẩm. Có thể bật, tắt, sắp xếp và chỉnh nội dung từng phần mà không làm thay đổi dữ liệu SKU gốc.
          </p>
        </div>
        <div className="post-template-revision" aria-label="Phiên bản bài viết mẫu">
          <span>{snapshot.isDefault ? "Mẫu mặc định" : `Phiên bản ${snapshot.version}`}</span>
          <strong>{formatDate(snapshot.updatedAt)}</strong>
          {snapshot.updatedBy ? <small>Cập nhật bởi {snapshot.updatedBy}</small> : null}
        </div>
      </section>

      <div className="post-template-safety-note">
        <strong>Phạm vi cập nhật an toàn</strong>
        <p>
          Khi lưu, hệ thống cập nhật bài chuẩn, bản nháp, lịch chờ và tác vụ chưa xuất bản. Bài đã đăng không bị sửa; tác vụ đang gửi ra kênh được giữ nguyên để tránh đăng trùng.
        </p>
      </div>

      {error ? <div className="post-template-message is-error" role="alert">{error}</div> : null}
      {notice ? <div className="post-template-message is-success" role="status" aria-live="polite">{notice}</div> : null}
      {refresh ? (
        <section className="post-template-refresh-summary" aria-label="Kết quả cập nhật cấu trúc">
          <article><span>Bài chuẩn</span><strong>{refresh.articles}</strong></article>
          <article><span>Bản nháp</span><strong>{refresh.drafts}</strong></article>
          <article><span>Tác vụ chờ</span><strong>{refresh.jobs}</strong></article>
          <article><span>Đã mở chặn</span><strong>{refresh.staleJobsRequeued}</strong></article>
          <article className={refresh.publishingJobsSkipped ? "is-warning" : ""}>
            <span>Đang đăng, giữ nguyên</span><strong>{refresh.publishingJobsSkipped}</strong>
          </article>
        </section>
      ) : null}

      <div className="post-template-layout">
        <div className="post-template-editor-column">
          <section className="post-template-card">
            <div className="post-template-card-heading">
              <div><span>01</span><h2>Thiết lập chung</h2></div>
              <p>Tên quản trị, tiêu đề và nội dung cố định trước hoặc sau các phần động.</p>
            </div>

            <label className="post-template-field">
              <span>Tên bài viết mẫu</span>
              <input
                maxLength={120}
                value={config.name}
                onChange={(event) => updateField("name", event.target.value)}
              />
            </label>

            <label className="post-template-field">
              <span>Mẫu tiêu đề</span>
              <input
                maxLength={300}
                value={config.titleTemplate}
                onChange={(event) => updateField("titleTemplate", event.target.value)}
                spellCheck={false}
              />
              <small>Được dùng: <code>{"{{product_name}}"}</code> và <code>{"{{sku}}"}</code>.</small>
            </label>

            <div className="post-template-two-fields">
              <label className="post-template-field">
                <span>Nội dung mở đầu</span>
                <textarea
                  rows={4}
                  value={config.introText}
                  placeholder="Nội dung cố định hiển thị trước phần đầu tiên (không bắt buộc)."
                  onChange={(event) => updateField("introText", event.target.value)}
                />
              </label>
              <label className="post-template-field">
                <span>Nội dung kết thúc</span>
                <textarea
                  rows={4}
                  value={config.outroText}
                  placeholder="Nội dung cố định hiển thị sau phần cuối cùng (không bắt buộc)."
                  onChange={(event) => updateField("outroText", event.target.value)}
                />
              </label>
            </div>

            <label className="post-template-field">
              <span>Thông tin liên hệ dùng chung</span>
              <textarea
                rows={12}
                value={config.contactText}
                onChange={(event) => updateField("contactText", event.target.value)}
              />
              <small>Nội dung này chỉ xuất hiện khi phần “Thông tin liên hệ” được bật.</small>
            </label>
          </section>

          <section className="post-template-card">
            <div className="post-template-card-heading">
              <div><span>02</span><h2>Cấu trúc các phần</h2></div>
              <p>Dùng nút lên/xuống để đổi thứ tự. Mỗi phần giữ đúng một biến dữ liệu để tránh trộn sai SKU.</p>
            </div>

            <div className="post-template-sections">
              {config.sections.map((section, index) => (
                <article className={section.enabled ? "post-template-section" : "post-template-section is-disabled"} key={section.key}>
                  <header>
                    <div className="post-template-order">
                      <strong>{String(index + 1).padStart(2, "0")}</strong>
                      <div>
                        <button
                          type="button"
                          onClick={() => moveSection(index, -1)}
                          disabled={index === 0}
                          aria-label={`Đưa ${section.label} lên trên`}
                        >↑</button>
                        <button
                          type="button"
                          onClick={() => moveSection(index, 1)}
                          disabled={index === config.sections.length - 1}
                          aria-label={`Đưa ${section.label} xuống dưới`}
                        >↓</button>
                      </div>
                    </div>
                    <div className="post-template-section-title">
                      <label>
                        <span>Tên phần</span>
                        <input
                          maxLength={80}
                          value={section.label}
                          onChange={(event) => updateSection(index, { label: event.target.value })}
                        />
                      </label>
                      <code>{placeholderByKey[section.key]}</code>
                    </div>
                    <label className="post-template-switch">
                      <input
                        type="checkbox"
                        checked={section.enabled}
                        onChange={(event) => updateSection(index, { enabled: event.target.checked })}
                      />
                      <span aria-hidden="true" />
                      <b>{section.enabled ? "Hiển thị" : "Đang ẩn"}</b>
                    </label>
                  </header>
                  <label className="post-template-field">
                    <span>Cấu trúc phần</span>
                    <textarea
                      rows={section.key === "description" || section.key === "contact" ? 4 : 2}
                      value={section.template}
                      spellCheck={false}
                      onChange={(event) => updateSection(index, { template: event.target.value })}
                    />
                    <small>Giữ đúng biến <code>{placeholderByKey[section.key]}</code>; có thể thay đổi nhãn, biểu tượng và câu dẫn xung quanh.</small>
                  </label>
                </article>
              ))}
            </div>
          </section>
        </div>

        <aside className="post-template-preview-column" aria-label="Xem trước bài viết">
          <section className="post-template-preview-card">
            <div className="post-template-preview-heading">
              <div><span>XEM TRƯỚC TRỰC TIẾP</span><h2>Bài sản phẩm mẫu</h2></div>
              <i>{config.sections.filter((section) => section.enabled).length}/8 phần</i>
            </div>
            <div className="post-template-preview-content">
              <strong>{preview.title || "Tiêu đề đang trống"}</strong>
              <pre>{preview.body || "Bài viết đang trống"}</pre>
            </div>
            <footer>
              <span>SKU minh họa: PH0006</span>
              <span>{preview.body.length.toLocaleString("vi-VN")} ký tự</span>
            </footer>
          </section>
        </aside>
      </div>

      <div className="post-template-savebar">
        <div>
          <strong>{dirty ? "Có thay đổi chưa lưu" : "Đã đồng bộ với phiên bản đang dùng"}</strong>
          <span>{dirty ? "Kiểm tra bản xem trước trước khi cập nhật toàn hệ thống." : `Dấu xác thực ${snapshot.fingerprint.slice(0, 12)}…`}</span>
        </div>
        <div>
          <button className="post-template-secondary-button" type="button" onClick={resetChanges} disabled={!dirty || saving}>
            Hoàn tác
          </button>
          <button className="post-template-primary-button" type="button" onClick={() => setConfirming(true)} disabled={!dirty || saving}>
            {saving ? <><span className="post-template-button-spinner" aria-hidden="true" /> Đang cập nhật…</> : "Lưu & cập nhật bài sau"}
          </button>
        </div>
      </div>

      {confirming ? (
        <div className="post-template-dialog-backdrop" role="presentation" onMouseDown={() => !saving && setConfirming(false)}>
          <section
            className="post-template-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="post-template-confirm-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="post-template-dialog-icon" aria-hidden="true">✓</span>
            <div>
              <span className="post-template-eyebrow">XÁC NHẬN CẬP NHẬT TOÀN HỆ THỐNG</span>
              <h2 id="post-template-confirm-title">Áp dụng cấu trúc bài viết mới?</h2>
              <p>
                Hệ thống sẽ lưu một phiên bản mới, cập nhật bài chuẩn, bản nháp và tác vụ chưa xuất bản. Bài đã đăng hoặc đang gửi đến kênh sẽ được giữ nguyên.
              </p>
            </div>
            <div className="post-template-dialog-summary">
              <span><b>{config.sections.filter((section) => section.enabled).length}</b>/8 phần đang hiển thị</span>
              <span>Phiên bản <b>{snapshot.version}</b> → <b>{snapshot.version + 1}</b></span>
            </div>
            <footer>
              <button className="post-template-secondary-button" type="button" onClick={() => setConfirming(false)} disabled={saving}>Kiểm tra lại</button>
              <button className="post-template-primary-button" type="button" onClick={() => void save()} disabled={saving} autoFocus>
                {saving ? "Đang cập nhật…" : "Xác nhận và áp dụng"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
