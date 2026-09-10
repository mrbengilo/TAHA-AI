import {
  assertCustomerCopyAllowed,
  sanitizeProductTextForCopy,
} from "./shoe-content";
import { hasCompleteFacebookStructure } from "./facebook-content";
import type { ProductContentInput, ProductContentProduct } from "./openai";
import {
  getPostTemplate,
  renderPostTemplate,
  type PostTemplateSnapshot,
  type PostTemplateValues,
} from "../post-template";

export const APPROVED_TEMPLATE_MODEL = "taha-approved-template-v3";
export const CANONICAL_ARTICLE_VERSION = "sku-canonical-v1";

const PROVIDERS = new Set([
  "facebook",
  "zalo",
  "zalo_personal",
  "website",
  "tiktokShop",
  "tiktok_shop",
  "shopee",
]);

function clean(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  return sanitizeProductTextForCopy(value).replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

function unique(values: readonly unknown[] | null | undefined, maxItems: number) {
  return [...new Set((values ?? []).map((value) => clean(value, 180)).filter(Boolean))].slice(0, maxItems);
}

function sentence(value: string) {
  const trimmed = value.replace(/[\s.,;:!?-]+$/u, "").trim();
  return trimmed ? `${trimmed}.` : "";
}

function hashtag(value: string) {
  const token = value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[đĐ]/gu, "d")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .slice(0, 70);
  return token ? `#${token}` : "";
}

function skuVariant(sku: string, variants: readonly string[]) {
  const index = [...sku].reduce((total, character) => total + character.codePointAt(0)!, 0) % variants.length;
  return variants[index];
}

function sourceClauses(product: ProductContentProduct) {
  return [product.name, product.description, ...(product.specifications ?? [])]
    .flatMap((value) => typeof value === "string" ? value.split(/[\n;|•]+/u) : [])
    .map((value) => clean(value, 320))
    .filter(Boolean);
}

function facts(product: ProductContentProduct) {
  return sourceClauses(product)
    .filter((value) => value.length >= 8)
    .filter((value) => !/(?:bảo\s*hành|quà\s*tặng|tặng\s*kèm|đổi\s*size|giao\s*hàng)/iu.test(value))
    .filter((value) => !/(?:không|chưa|không\s+có)\s+(?:được\s+)?(?:bảo\s*hành|quà\s*tặng|tặng\s+kèm)/iu.test(value))
    .filter((value) => !/^https?:\/\//iu.test(value));
}

function normalizedProduct(product: ProductContentProduct) {
  const sku = clean(product.sku, 128);
  if (!sku) throw new Error("TEMPLATE_SKU_REQUIRED");
  const name = clean(product.name, 300) || `Giày ${sku}`;
  const brand = clean(product.brand, 120);
  const category = clean(product.category, 140);
  return {
    ...product,
    sku,
    name,
    brand,
    category,
    sizes: unique(product.sizes, 30),
    colors: unique(product.colors, 30),
    gifts: unique(product.gifts, 20),
    specifications: unique(product.specifications, 80),
  };
}

function editorialProductName(product: ReturnType<typeof normalizedProduct>) {
  const policySegment = /^(?:bảo\s*hành|quà\s*tặng|tặng\s*kèm|miễn\s*phí\s*(?:giao\s*hàng|vận\s*chuyển|ship)|đổi\s*(?:size|cỡ)|kiểm\s*tra\s*hàng)/iu;
  const escapedSku = product.sku.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const core = product.name
    .split(/\s+[-–—]\s+/u)
    .map((segment) => segment
      .replace(/\bSKU\b/giu, "")
      .replace(new RegExp(`(?:^|\\s)${escapedSku}(?=\\s|$)`, "giu"), " ")
      .replace(/\s+/gu, " ")
      .trim())
    .filter((segment) => segment && !policySegment.test(segment))
    .join(" – ")
    .replace(/\s+(?:bảo\s*hành|quà\s*tặng|tặng\s*kèm)\b[\s\S]*$/iu, "")
    .trim();
  const safeCore = /(?:hotline|zalo|facebook|website|tiktok|shopee|https?:\/\/|quà\s*tặng|tặng\s*kèm|bảo\s*hành)/iu.test(core)
    || (core.match(/\p{L}/gu)?.length ?? 0) < 3
    ? ""
    : core;
  return safeCore || product.brand || product.category || "Giày";
}

function needsEditorialCorrection(product: ReturnType<typeof normalizedProduct>) {
  return /(?:\bSKU\b|bảo\s*hành|quà\s*tặng|tặng\s*kèm|hotline|zalo|facebook|website|tiktok|shopee|https?:\/\/)/iu.test(product.name)
    || editorialProductName(product) === "Giày";
}

function baseSections(product: ReturnType<typeof normalizedProduct>) {
  const sourceFacts = facts(product).slice(0, 3);
  const identity = product.category || "sneaker thể thao";
  const productName = editorialProductName(product);
  const firstFact = sourceFacts[0]
    ? `Thông tin sản phẩm ghi nhận: ${sentence(sourceFacts[0])}`
    : `Các chi tiết được trình bày theo đúng thông tin của mẫu ${product.sku}.`;
  const secondFact = sourceFacts[1] ? ` ${sentence(sourceFacts[1])}` : "";
  const colorNote = product.colors.length ? ` với lựa chọn màu ${product.colors.join(", ")}` : "";
  const hook = skuVariant(product.sku, [
    `👟 ${productName} mang đến một lựa chọn dễ phối cho phong cách hằng ngày${colorNote}.`,
    `✨ Khám phá ${productName} — mẫu ${identity} có thông tin riêng được giữ đúng theo mã ${product.sku}.`,
    `🔥 ${productName} tạo điểm nhấn năng động mà vẫn thuận tiện khi phối trang phục thường ngày${colorNote}.`,
  ]);
  return [
    hook,
    `🎨 Thiết kế: ${productName} được định hình theo kiểu dáng ${identity}, tập trung vào vẻ ngoài rõ nét và dễ nhận diện. ${firstFact}`,
    `✨ Ưu điểm: Những chi tiết nêu trên giúp mẫu ${product.sku} giữ được phong cách chỉn chu và linh hoạt khi kết hợp trang phục.${secondFact}`,
    `🚶 Ứng dụng: Có thể phối mẫu ${product.sku} cùng quần jeans, quần thể thao hoặc trang phục casual cho đi học, đi làm và dạo phố hằng ngày.`,
  ].join("\n\n");
}

function fallbackFacebookSections(product: ReturnType<typeof normalizedProduct>) {
  return [
    `👟 Mẫu giày ${product.sku} là lựa chọn dễ phối cho phong cách hằng ngày.`,
    `🎨 Thiết kế: Mẫu ${product.sku} được giới thiệu theo đúng mã sản phẩm, với cách trình bày rõ ràng để khách hàng dễ nhận diện khi lựa chọn.`,
    `✨ Ưu điểm: Nội dung của mẫu ${product.sku} tập trung vào thông tin đã xác nhận, tránh thêm đặc tính hoặc cam kết chưa có trong dữ liệu nguồn.`,
    `🚶 Ứng dụng: Có thể phối mẫu ${product.sku} cùng quần jeans, quần thể thao hoặc trang phục casual cho đi học, đi làm và dạo phố hằng ngày.`,
  ].join("\n\n");
}

function hasNegation(value: string, keyword: RegExp) {
  return new RegExp(`(?:không|chưa|không\\s+có)\\s+(?:được\\s+)?${keyword.source}`, "iu").test(value);
}

function extractedWarranty(product: ReturnType<typeof normalizedProduct>) {
  const keyword = /bảo\s*hành/iu;
  for (const clause of sourceClauses(product)) {
    if (!keyword.test(clause) || hasNegation(clause, keyword)) continue;
    const match = clause.match(/bảo\s*hành\s*(?:chính\s*hãng\s*)?(\d{1,3}\s*(?:tháng|ngày|năm))/iu);
    if (match?.[1]) return clean(match[1].toLocaleLowerCase("vi-VN"), 80);
  }
  return "";
}

function cleanGiftValue(value: string) {
  return clean(value, 240)
    .replace(/\s*(?:&|\bvà\b)\s*/giu, " + ")
    .replace(/\s*\+\s*/gu, " + ")
    .replace(/[\s.,;:!?-]+$/u, "")
    .toLocaleLowerCase("vi-VN")
    .trim();
}

function extractedGifts(product: ReturnType<typeof normalizedProduct>) {
  const explicit = product.gifts.map(cleanGiftValue).filter(Boolean);
  if (explicit.length) return [...new Set(explicit)].join(" + ");
  const keyword = /(?:quà\s*tặng|tặng\s*kèm)/iu;
  for (const clause of sourceClauses(product)) {
    if (!keyword.test(clause) || hasNegation(clause, keyword)) continue;
    const match = clause.match(/(?:quà\s*tặng|tặng\s*kèm)\s*[:\-–—]?\s*([^\n;|]+)/iu);
    if (!match?.[1]) continue;
    const value = cleanGiftValue(match[1].split(/\s+[-–—]\s+/u)[0]);
    if (value) return value;
  }
  return "";
}

function contentHashtags(product: ReturnType<typeof normalizedProduct>) {
  return [...new Set([
    "#TAHAShoes",
    hashtag(product.sku),
    hashtag(product.brand),
    hashtag(product.category),
    "#GiayTheThao",
    "#PhongCachHangNgay",
  ].filter(Boolean))];
}

function templateValues(
  product: ReturnType<typeof normalizedProduct>,
  template: PostTemplateSnapshot,
  description: string,
): PostTemplateValues {
  return {
    product_name: editorialProductName(product),
    sku: product.sku,
    sizes: product.sizes.join(", "),
    description,
    gifts: extractedGifts(product),
    warranty: extractedWarranty(product),
    contact: template.config.contactText,
    hashtags: contentHashtags(product).join(" "),
  };
}

/**
 * Pure deterministic renderer used by production generation and by the
 * template-update transaction before it changes any saved article.
 */
export async function generateProductContentWithTemplate(
  input: ProductContentInput,
  template: PostTemplateSnapshot,
): Promise<{ model: string; content: Record<string, unknown>; usage: Record<string, unknown> }> {
  const product = normalizedProduct(input.product);
  const targetProviders = [...new Set(input.targetProviders)];
  if (!targetProviders.length || targetProviders.some((provider) => !PROVIDERS.has(provider))) {
    throw new Error("TEMPLATE_TARGET_PROVIDERS_INVALID");
  }
  const sections = baseSections(product);
  const canonicalDescription = !hasCompleteFacebookStructure(sections)
    ? fallbackFacebookSections(product)
    : sections;
  if (!hasCompleteFacebookStructure(canonicalDescription)) {
    throw new Error("TEMPLATE_FACEBOOK_STRUCTURE_INVALID");
  }
  const sourceCorrections = [
    ...(needsEditorialCorrection(product) ? ["sku_editorial_name_normalized"] : []),
    ...(canonicalDescription !== sections ? ["canonical_structure_fallback"] : []),
  ];
  const rendered = renderPostTemplate(
    template.config,
    templateValues(product, template, canonicalDescription),
  );
  const canonicalArticle = {
    version: CANONICAL_ARTICLE_VERSION,
    title: rendered.title,
    body: rendered.body,
    // Hashtags are rendered inside the administrator-defined block so their
    // position can change or the entire section can be hidden without the
    // publisher appending a second copy at the end.
    hashtags: [],
  };
  assertCustomerCopyAllowed(canonicalArticle);
  return {
    model: APPROVED_TEMPLATE_MODEL,
    content: {
      sku: product.sku,
      canonicalArticle,
      sourceCorrections,
      postTemplate: {
        id: template.id,
        version: template.version,
        fingerprint: template.fingerprint,
      },
    },
    usage: {
      source: "approved-template",
      externalRequests: 0,
      articleWrites: 1,
      sharedAcrossChannels: targetProviders,
      sourceCorrections,
    },
  };
}

/**
 * Writes one canonical article for the SKU without any external AI request.
 * Every delivery channel reuses this exact saved title and body.
 */
export async function generateProductContent(
  input: ProductContentInput,
): Promise<{ model: string; content: Record<string, unknown>; usage: Record<string, unknown> }> {
  return generateProductContentWithTemplate(input, await getPostTemplate());
}
