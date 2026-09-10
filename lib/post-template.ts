import { ShoeContentPolicyError, assertCustomerCopyAllowed } from "./ai/shoe-content";
import { getRuntimeEnv } from "./integrations/env";
import { ensureWorkspace, TAHA_WORKSPACE_ID } from "./integrations/store";

export const POST_TEMPLATE_KEY = "product_post";
export const POST_TEMPLATE_SCHEMA_VERSION = "post-template-v1";
export const POST_TEMPLATE_ID = "post_template_product_post";

export const POST_TEMPLATE_SECTION_DEFINITIONS = [
  { key: "product_name", label: "Tên sản phẩm", placeholder: "{{product_name}}" },
  { key: "sku", label: "Mã sản phẩm", placeholder: "{{sku}}" },
  { key: "sizes", label: "Size", placeholder: "{{sizes}}" },
  { key: "description", label: "Mô tả sản phẩm", placeholder: "{{description}}" },
  { key: "gifts", label: "Quà tặng", placeholder: "{{gifts}}" },
  { key: "warranty", label: "Bảo hành", placeholder: "{{warranty}}" },
  { key: "contact", label: "Thông tin liên hệ", placeholder: "{{contact}}" },
  { key: "hashtags", label: "Hashtag", placeholder: "{{hashtags}}" },
] as const;

export type PostTemplateSectionKey = (typeof POST_TEMPLATE_SECTION_DEFINITIONS)[number]["key"];

export type PostTemplateSection = {
  key: PostTemplateSectionKey;
  label: string;
  enabled: boolean;
  template: string;
};

export type PostTemplateConfig = {
  schemaVersion: typeof POST_TEMPLATE_SCHEMA_VERSION;
  name: string;
  titleTemplate: string;
  introText: string;
  outroText: string;
  contactText: string;
  sections: PostTemplateSection[];
};

export type PostTemplateSnapshot = {
  id: string;
  key: typeof POST_TEMPLATE_KEY;
  version: number;
  fingerprint: string;
  config: PostTemplateConfig;
  updatedBy: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  isDefault: boolean;
};

export type PostTemplateValues = Record<PostTemplateSectionKey, string>;

export type PostTemplateRefreshResult = {
  articles: number;
  drafts: number;
  jobs: number;
  staleJobsRequeued: number;
  publishingJobsSkipped: number;
};

type TemplateRow = {
  id: string;
  template_key: string;
  name: string;
  version: number;
  fingerprint: string;
  config_json: string;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
};

type D1Result = { meta?: { changes?: number } };

type TemplateStatement = {
  bind(...values: unknown[]): TemplateStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results?: T[] }>;
  run(): Promise<D1Result>;
};

export type PostTemplateDatabase = {
  prepare(query: string): TemplateStatement;
  batch(statements: TemplateStatement[]): Promise<D1Result[]>;
};

export class PostTemplateError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(code);
    this.name = "PostTemplateError";
  }
}

const MAX_TEMPLATE_NAME = 120;
const MAX_TITLE_TEMPLATE = 300;
const MAX_SECTION_LABEL = 80;
const MAX_SECTION_TEMPLATE = 4_000;
const MAX_FREE_TEXT = 8_000;
const MAX_RENDERED_BODY = 20_000;
const PLACEHOLDER_PATTERN = /\{\{\s*([a-z_]+)\s*\}\}/giu;
const TITLE_PLACEHOLDERS = new Set<PostTemplateSectionKey>(["product_name", "sku"]);

function assertTemplateCopyAllowed(copy: { title: string; body: string }) {
  try {
    assertCustomerCopyAllowed({ ...copy, hashtags: [] });
  } catch (error) {
    if (!(error instanceof ShoeContentPolicyError)) throw error;
    const messages = {
      CONTENT_PRICE_FORBIDDEN: "Bài viết mẫu không được chứa giá bán hoặc nội dung báo giá cố định.",
      CONTENT_INTERNAL_TEXT_FORBIDDEN: "Bài viết mẫu chứa thuật ngữ nội bộ không được phép hiển thị cho khách hàng.",
      CONTENT_WORD_LIMIT_EXCEEDED: "Bài viết mẫu sau khi hiển thị vượt quá giới hạn 2.000 từ.",
    } as const;
    throw new PostTemplateError("POST_TEMPLATE_CONTENT_POLICY", messages[error.code], 400);
  }
}

const DEFAULT_CONTACT_TEXT = [
  "🛍️ MUA SẮM CÙNG TAHA SHOES",
  "📦 Mỗi sản phẩm được đóng gói bằng bọc chống sốc và hộp bảo vệ.",
  "🚚 Miễn phí giao hàng toàn quốc.",
  "🔄 Đổi size miễn phí trong 7 ngày.",
  "📦 Được kiểm tra hàng trước khi nhận; nhận hàng trước, thanh toán sau.",
  "Nếu chưa hài lòng về sản phẩm hoặc dịch vụ, vui lòng liên hệ TAHA SHOES để được hỗ trợ.",
  "",
  "💬 Nhắn TAHA SHOES để được tư vấn sản phẩm và chọn size phù hợp.",
  "THÔNG TIN LIÊN HỆ",
  "☎️ Hotline: 0765.109.784",
  "📲 Zalo: 0765.109.784 (TAHA SHOES)",
  "📌 Facebook: TAHA SHOES",
  "🌐 Website: https://tahashoes.vn",
  "❤️ TikTok: https://www.tiktok.com/@tahashoes.vn",
  "🧡 Shopee: https://shopee.vn/bengilo#product_list",
].join("\n");

export const DEFAULT_POST_TEMPLATE_CONFIG: PostTemplateConfig = {
  schemaVersion: POST_TEMPLATE_SCHEMA_VERSION,
  name: "Bài viết sản phẩm TAHA SHOES",
  titleTemplate: "{{product_name}}",
  introText: "",
  outroText: "",
  contactText: DEFAULT_CONTACT_TEXT,
  sections: [
    { key: "product_name", label: "Tên sản phẩm", enabled: true, template: "👟 {{product_name}}" },
    { key: "sku", label: "Mã sản phẩm", enabled: true, template: "🏷️ Mã sản phẩm: {{sku}}" },
    { key: "sizes", label: "Size", enabled: true, template: "📏 Size hiện có: {{sizes}}" },
    { key: "description", label: "Mô tả sản phẩm", enabled: true, template: "{{description}}" },
    { key: "gifts", label: "Quà tặng", enabled: true, template: "🎁 Quà tặng kèm: {{gifts}}." },
    { key: "warranty", label: "Bảo hành", enabled: true, template: "🛡️ Bảo hành {{warranty}}." },
    { key: "contact", label: "Thông tin liên hệ", enabled: true, template: "{{contact}}" },
    { key: "hashtags", label: "Hashtag", enabled: true, template: "{{hashtags}}" },
  ],
};

export const POST_TEMPLATE_PREVIEW_VALUES: PostTemplateValues = {
  product_name: "Lituo Sport PH0006 – Sneaker cao cấp, thoải mái và dễ phối",
  sku: "PH0006",
  sizes: "36, 37, 38, 39, 40, 41, 42, 43",
  description: [
    "✨ Một lựa chọn năng động, dễ kết hợp trong nhiều phong cách hằng ngày.",
    "🎨 Thiết kế: Kiểu dáng sneaker gọn gàng, tập trung vào vẻ ngoài hiện đại và dễ nhận diện.",
    "✨ Ưu điểm: Cấu trúc sản phẩm được trình bày theo dữ liệu đã xác nhận, giúp khách hàng dễ lựa chọn đúng mẫu.",
    "🚶 Ứng dụng: Phù hợp phối cùng quần jeans, quần thể thao hoặc trang phục casual khi đi học, đi làm và dạo phố.",
  ].join("\n\n"),
  gifts: "khử mùi + vớ thể thao",
  warranty: "12 tháng",
  contact: DEFAULT_CONTACT_TEXT,
  hashtags: "#TAHAShoes #PH0006 #LituoSport #GiayTheThao #PhongCachHangNgay",
};

function database(override?: PostTemplateDatabase) {
  const value = override ?? (getRuntimeEnv().DB as unknown as PostTemplateDatabase | undefined);
  if (!value) return null;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanString(value: unknown, maxLength: number, field: string, required = false) {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return "";
    throw new PostTemplateError("POST_TEMPLATE_INVALID", `${field} không hợp lệ.`);
  }
  const normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (required && !normalized) throw new PostTemplateError("POST_TEMPLATE_INVALID", `${field} không được để trống.`);
  if (normalized.length > maxLength) {
    throw new PostTemplateError("POST_TEMPLATE_INVALID", `${field} vượt quá ${maxLength.toLocaleString("vi-VN")} ký tự.`);
  }
  return normalized;
}

function definitionFor(key: PostTemplateSectionKey) {
  return POST_TEMPLATE_SECTION_DEFINITIONS.find((item) => item.key === key)!;
}

function normalizeTitleTemplate(value: unknown) {
  const template = cleanString(value, MAX_TITLE_TEMPLATE, "Mẫu tiêu đề", true);
  const placeholders = [...template.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1].toLowerCase());
  if (!placeholders.length || placeholders.some((key) => !TITLE_PLACEHOLDERS.has(key as PostTemplateSectionKey))) {
    throw new PostTemplateError(
      "POST_TEMPLATE_INVALID",
      "Mẫu tiêu đề chỉ được dùng {{product_name}} và {{sku}}, đồng thời phải có ít nhất một biến.",
    );
  }
  return template;
}

function normalizeSection(value: unknown, index: number): PostTemplateSection {
  const input = asRecord(value);
  const key = typeof input.key === "string" ? input.key.trim().toLowerCase() : "";
  if (!POST_TEMPLATE_SECTION_DEFINITIONS.some((item) => item.key === key)) {
    throw new PostTemplateError("POST_TEMPLATE_INVALID", `Phần bài viết số ${index + 1} không hợp lệ.`);
  }
  if (typeof input.enabled !== "boolean") {
    throw new PostTemplateError("POST_TEMPLATE_INVALID", `Trạng thái hiển thị của phần ${key} không hợp lệ.`);
  }
  const typedKey = key as PostTemplateSectionKey;
  const definition = definitionFor(typedKey);
  const template = cleanString(input.template, MAX_SECTION_TEMPLATE, `Cấu trúc phần ${definition.label}`, true);
  const placeholders = [...template.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1].toLowerCase());
  if (placeholders.length !== 1 || placeholders[0] !== typedKey) {
    throw new PostTemplateError(
      "POST_TEMPLATE_INVALID",
      `Phần ${definition.label} phải chứa đúng một biến ${definition.placeholder} và không được dùng biến của phần khác.`,
    );
  }
  return {
    key: typedKey,
    label: cleanString(input.label, MAX_SECTION_LABEL, `Tên phần ${definition.label}`, true),
    enabled: input.enabled,
    template,
  };
}

export function normalizePostTemplateConfig(value: unknown): PostTemplateConfig {
  const input = asRecord(value);
  if (!Array.isArray(input.sections) || input.sections.length !== POST_TEMPLATE_SECTION_DEFINITIONS.length) {
    throw new PostTemplateError(
      "POST_TEMPLATE_INVALID",
      `Bài viết mẫu phải có đủ ${POST_TEMPLATE_SECTION_DEFINITIONS.length} phần để quản trị viên bật, tắt hoặc sắp xếp.`,
    );
  }
  const sections = input.sections.map(normalizeSection);
  const keys = sections.map((section) => section.key);
  if (new Set(keys).size !== POST_TEMPLATE_SECTION_DEFINITIONS.length
    || POST_TEMPLATE_SECTION_DEFINITIONS.some((definition) => !keys.includes(definition.key))) {
    throw new PostTemplateError("POST_TEMPLATE_INVALID", "Bài viết mẫu bị thiếu hoặc lặp phần nội dung.");
  }
  const config: PostTemplateConfig = {
    schemaVersion: POST_TEMPLATE_SCHEMA_VERSION,
    name: cleanString(input.name, MAX_TEMPLATE_NAME, "Tên bài viết mẫu", true),
    titleTemplate: normalizeTitleTemplate(input.titleTemplate),
    introText: cleanString(input.introText, MAX_FREE_TEXT, "Nội dung mở đầu"),
    outroText: cleanString(input.outroText, MAX_FREE_TEXT, "Nội dung kết thúc"),
    contactText: cleanString(input.contactText, MAX_FREE_TEXT, "Thông tin liên hệ"),
    sections,
  };
  const preview = renderPostTemplate(config, POST_TEMPLATE_PREVIEW_VALUES);
  if (!preview.body) throw new PostTemplateError("POST_TEMPLATE_INVALID", "Bài viết mẫu không được tạo ra nội dung trống.");
  assertTemplateCopyAllowed(preview);
  return config;
}

function normalizedForStorage(config: PostTemplateConfig) {
  return {
    schemaVersion: config.schemaVersion,
    name: config.name,
    titleTemplate: config.titleTemplate,
    introText: config.introText,
    outroText: config.outroText,
    contactText: config.contactText,
    sections: config.sections.map((section) => ({
      key: section.key,
      label: section.label,
      enabled: section.enabled,
      template: section.template,
    })),
  };
}

export async function fingerprintPostTemplate(config: PostTemplateConfig) {
  const bytes = new TextEncoder().encode(JSON.stringify(normalizedForStorage(config)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function replaceVariables(template: string, values: Partial<PostTemplateValues>, allowed: ReadonlySet<PostTemplateSectionKey>) {
  return template.replace(PLACEHOLDER_PATTERN, (_match, rawKey: string) => {
    const key = rawKey.toLowerCase() as PostTemplateSectionKey;
    if (!allowed.has(key)) throw new PostTemplateError("POST_TEMPLATE_INVALID", `Biến {{${rawKey}}} không được hỗ trợ.`);
    return values[key] ?? "";
  }).trim();
}

export function renderPostTemplate(config: PostTemplateConfig, values: PostTemplateValues) {
  const title = replaceVariables(config.titleTemplate, values, TITLE_PLACEHOLDERS).replace(/\s+/gu, " ").trim();
  const blocks = [config.introText];
  for (const section of config.sections) {
    if (!section.enabled) continue;
    const value = values[section.key].trim();
    if (!value) continue;
    blocks.push(replaceVariables(section.template, { [section.key]: value }, new Set([section.key])));
  }
  blocks.push(config.outroText);
  const body = blocks.map((block) => block.trim()).filter(Boolean).join("\n\n").trim();
  if (!title) throw new PostTemplateError("POST_TEMPLATE_RENDER_INVALID", "Mẫu tiêu đề tạo ra nội dung trống.");
  if (!body) throw new PostTemplateError("POST_TEMPLATE_RENDER_INVALID", "Bài viết mẫu tạo ra nội dung trống.");
  if (body.length > MAX_RENDERED_BODY) {
    throw new PostTemplateError("POST_TEMPLATE_RENDER_INVALID", "Bài viết sau khi áp dụng mẫu vượt quá 20.000 ký tự.");
  }
  if (/\{\{\s*[a-z_]+\s*\}\}/iu.test(`${title}\n${body}`)) {
    throw new PostTemplateError("POST_TEMPLATE_RENDER_INVALID", "Bài viết còn biến chưa được thay thế.");
  }
  assertTemplateCopyAllowed({ title, body });
  return { title, body };
}

export function previewPostTemplate(config: PostTemplateConfig) {
  return renderPostTemplate(config, {
    ...POST_TEMPLATE_PREVIEW_VALUES,
    contact: config.contactText,
  });
}

function rowSnapshot(row: TemplateRow, config: PostTemplateConfig): PostTemplateSnapshot {
  return {
    id: row.id,
    key: POST_TEMPLATE_KEY,
    version: Number(row.version),
    fingerprint: row.fingerprint,
    config,
    updatedBy: row.updated_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    isDefault: false,
  };
}

export async function defaultPostTemplateSnapshot(): Promise<PostTemplateSnapshot> {
  const config = normalizePostTemplateConfig(DEFAULT_POST_TEMPLATE_CONFIG);
  return {
    id: POST_TEMPLATE_ID,
    key: POST_TEMPLATE_KEY,
    version: 0,
    fingerprint: await fingerprintPostTemplate(config),
    config,
    updatedBy: null,
    createdAt: null,
    updatedAt: null,
    isDefault: true,
  };
}

export async function getPostTemplate(override?: PostTemplateDatabase): Promise<PostTemplateSnapshot> {
  const db = database(override);
  if (!db) return defaultPostTemplateSnapshot();
  await ensureWorkspace();
  const row = await db.prepare(
    `SELECT id,template_key,name,version,fingerprint,config_json,updated_by,created_at,updated_at
     FROM post_templates WHERE workspace_id=? AND template_key=? LIMIT 1`,
  ).bind(TAHA_WORKSPACE_ID, POST_TEMPLATE_KEY).first<TemplateRow>();
  if (!row) return defaultPostTemplateSnapshot();
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config_json);
  } catch {
    throw new PostTemplateError("POST_TEMPLATE_CORRUPTED", "Dữ liệu bài viết mẫu đang bị lỗi.", 500);
  }
  const config = normalizePostTemplateConfig({ ...asRecord(parsed), name: row.name });
  const fingerprint = await fingerprintPostTemplate(config);
  if (fingerprint !== row.fingerprint) {
    throw new PostTemplateError("POST_TEMPLATE_CORRUPTED", "Dữ liệu bài viết mẫu không khớp dấu xác thực.", 500);
  }
  return rowSnapshot(row, config);
}

export function postTemplateErrorResponse(error: unknown) {
  if (error instanceof PostTemplateError) {
    return { code: error.code, message: error.userMessage, status: error.status, details: error.details };
  }
  return {
    code: "POST_TEMPLATE_FAILED",
    message: "Không thể xử lý bài viết mẫu. Vui lòng kiểm tra lại dữ liệu.",
    status: 500,
    details: undefined,
  };
}

export function changes(result: D1Result | undefined) {
  return Number(result?.meta?.changes ?? 0);
}

export function requirePostTemplateDatabase(override?: PostTemplateDatabase) {
  const db = database(override);
  if (!db) throw new PostTemplateError("DATABASE_UNAVAILABLE", "Cơ sở dữ liệu chưa sẵn sàng.", 503);
  return db;
}
