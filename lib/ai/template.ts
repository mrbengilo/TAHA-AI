import {
  appendShoeCustomerReference,
  assertCustomerCopyAllowed,
  sanitizeProductTextForCopy,
} from "./shoe-content";
import {
  facebookStoreReferenceText,
  hasCompleteFacebookStructure,
} from "./facebook-content";
import type { ChannelContent, ProductContentInput, ProductContentProduct } from "./openai";

export const APPROVED_TEMPLATE_MODEL = "taha-approved-template-v2";

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

function clippedTitle(value: string, maxLength = 178) {
  if (value.length <= maxLength) return value;
  const clipped = value.slice(0, maxLength - 1);
  const boundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, boundary > 90 ? boundary : clipped.length).trim()}…`;
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

function facts(product: ProductContentProduct) {
  const candidates = [product.description, ...(product.specifications ?? [])]
    .flatMap((value) => typeof value === "string" ? value.split(/[\n;|•]+/u) : [])
    .map((value) => clean(value, 280))
    .filter((value) => value.length >= 8)
    .filter((value) => !/(?:bảo\s*hành|quà\s*tặng|tặng\s*kèm|đổi\s*size|giao\s*hàng)/iu.test(value));
  return [...new Set(candidates)].slice(0, 3);
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
  const core = product.name
    .split(/\s+[-–—]\s+/u)
    .map((segment) => segment.replace(/\bSKU\b/giu, "").trim())
    .filter((segment) => segment && !policySegment.test(segment))
    .join(" – ")
    .replace(/\s+(?:bảo\s*hành|quà\s*tặng|tặng\s*kèm)\b[\s\S]*$/iu, "")
    .trim();
  const identity = core || product.brand || product.category || "Giày";
  return identity.toLocaleUpperCase("vi-VN").includes(product.sku.toLocaleUpperCase("vi-VN"))
    ? identity
    : `${identity} – ${product.sku}`;
}

function baseSections(product: ReturnType<typeof normalizedProduct>) {
  const sourceFacts = facts(product);
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

function websiteDescription(product: ReturnType<typeof normalizedProduct>, sections: string) {
  const sourceFacts = facts(product);
  return [
    `✨ ${product.name}`,
    `Một mẫu ${product.category || "giày thể thao"} dành cho phong cách hằng ngày, được trình bày theo đúng thông tin của mã ${product.sku}.`,
    "◆ THIẾT KẾ",
    sections.match(/🎨 Thiết kế:\s*([\s\S]*?)(?=\n\n✨ Ưu điểm:)/u)?.[1]?.trim() || `Kiểu dáng của mẫu ${product.sku} dễ nhận diện và thuận tiện khi phối đồ.`,
    "◆ ĐIỂM NỔI BẬT",
    sourceFacts.length
      ? sourceFacts.map((item) => `• ${sentence(item)}`).join("\n")
      : `• Thông tin, hình ảnh và mã sản phẩm được giữ đồng nhất cho mẫu ${product.sku}.`,
    "◆ GỢI Ý SỬ DỤNG",
    `Phối cùng quần jeans, quần thể thao hoặc trang phục casual để tạo tổng thể năng động, gọn gàng trong các hoạt động thường ngày.`,
  ].join("\n\n");
}

function channelTitle(product: ReturnType<typeof normalizedProduct>, provider: string) {
  if (provider === "website" || provider === "tiktok_shop" || provider === "tiktokShop" || provider === "shopee") {
    return clippedTitle(product.name.includes(product.sku) ? product.name : `${product.name} – ${product.sku}`);
  }
  const prefix = product.brand || product.category || "TAHA SHOES";
  return clippedTitle(`✨ ${prefix} ${product.sku} – ${product.name}`);
}

function channelBody(
  provider: string,
  product: ReturnType<typeof normalizedProduct>,
  sections: string,
  description: string,
) {
  if (provider === "facebook") {
    return `${appendShoeCustomerReference(sections, product)}\n\n${facebookStoreReferenceText(product)}`;
  }
  if (provider === "website") return appendShoeCustomerReference(description, product);
  if (provider === "zalo" || provider === "zalo_personal") {
    return appendShoeCustomerReference([
      sections,
      "💬 Nhắn TAHA SHOES để được hỗ trợ thêm về sản phẩm và chọn size phù hợp.",
    ].join("\n\n"), product);
  }
  return appendShoeCustomerReference(description, product);
}

/**
 * Writes every channel from the approved 28/08 store structure without any
 * external AI request. Product facts remain scoped to the current Sheet SKU.
 */
export async function generateProductContent(
  input: ProductContentInput,
): Promise<{ model: string; content: Record<string, unknown>; usage: Record<string, unknown> }> {
  const product = normalizedProduct(input.product);
  const targetProviders = [...new Set(input.targetProviders)];
  if (!targetProviders.length || targetProviders.some((provider) => !PROVIDERS.has(provider))) {
    throw new Error("TEMPLATE_TARGET_PROVIDERS_INVALID");
  }
  const sections = baseSections(product);
  const needsFacebook = targetProviders.includes("facebook");
  const facebookSections = needsFacebook && !hasCompleteFacebookStructure(sections)
    ? fallbackFacebookSections(product)
    : sections;
  if (needsFacebook && !hasCompleteFacebookStructure(facebookSections)) {
    throw new Error("TEMPLATE_FACEBOOK_STRUCTURE_INVALID");
  }
  const sourceCorrections = [
    ...(needsFacebook && editorialProductName(product) !== product.name ? ["facebook_editorial_name_normalized"] : []),
    ...(needsFacebook && facebookSections !== sections ? ["facebook_structure_fallback"] : []),
  ];
  const description = websiteDescription(product, sections);
  const hashtags = [...new Set([
    "#TAHAShoes",
    hashtag(product.sku),
    hashtag(product.brand),
    hashtag(product.category),
    "#GiayTheThao",
    "#PhongCachHangNgay",
  ].filter(Boolean))];
  const channels: Record<string, ChannelContent> = {};
  for (const provider of targetProviders) {
    const channel = {
      title: channelTitle(product, provider),
      body: channelBody(provider, product, provider === "facebook" ? facebookSections : sections, description),
      hashtags,
    };
    assertCustomerCopyAllowed(channel);
    channels[provider] = channel;
  }
  const productDescription = appendShoeCustomerReference(description, product);
  assertCustomerCopyAllowed({ body: productDescription, hashtags });
  return {
    model: APPROVED_TEMPLATE_MODEL,
    content: { sku: product.sku, productDescription, hashtags, channels, sourceCorrections },
    usage: { source: "approved-template", externalRequests: 0, sourceCorrections },
  };
}
