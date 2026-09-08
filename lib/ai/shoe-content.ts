export const MAX_CUSTOMER_POST_WORDS = 2_000;

export const SHOE_SIZE_CHART = {
  female: [
    { size: 36, minCm: "21.6", maxCm: "22.5" },
    { size: 37, minCm: "22.6", maxCm: "23.5" },
    { size: 38, minCm: "23.6", maxCm: "24.1" },
    { size: 39, minCm: "24.2", maxCm: "25.1" },
    { size: 40, minCm: "25.2", maxCm: "25.9" },
    { size: 41, minCm: "26.0", maxCm: "26.7" },
    { size: 42, minCm: "26.8", maxCm: "27.6" },
    { size: 43, minCm: "27.7", maxCm: "28.5" },
    { size: 44, minCm: "28.6", maxCm: "30.0" },
  ],
  male: [
    { size: 36, minCm: "21.6", maxCm: "22.5" },
    { size: 37, minCm: "22.5", maxCm: "22.9" },
    { size: 38, minCm: "23.0", maxCm: "23.8" },
    { size: 39, minCm: "23.9", maxCm: "24.5" },
    { size: 40, minCm: "24.6", maxCm: "25.3" },
    { size: 41, minCm: "25.4", maxCm: "26.1" },
    { size: 42, minCm: "26.2", maxCm: "26.8" },
    { size: 43, minCm: "26.9", maxCm: "27.7" },
    { size: 44, minCm: "27.8", maxCm: "28.5" },
  ],
} as const;

// Verbatim customer-provided reference text. The public appendix below condenses it
// and qualifies material-dependent cleaning advice without changing the size data.
export const SHOE_STORAGE_GUIDANCE = [
  { title: "Tránh nhiệt độ cao", text: "Không cho giày tiếp xúc trực tiếp dưới lửa hoặc nguồn nhiệt lớn để tránh làm hỏng keo và biến dạng chất liệu." },
  { title: "Hạn chế ngâm nước", text: "Không ngâm giày quá lâu trong nước vì sẽ làm mục chất liệu vải và bong tróc lớp keo dán." },
  { title: "Phơi nắng đúng cách", text: "Tránh phơi giày trực tiếp dưới ánh nắng gay gắt trong thời gian dài để bảo vệ màu sắc nguyên bản." },
  { title: "Tránh hóa chất", text: "Cẩn thận không để dầu mỡ hoặc các chất kết dính rơi trực tiếp vào giày, gây hư hại bề mặt." },
  { title: "Nơi khô ráo", text: "Luôn bảo quản giày ở nơi khô ráo, thoáng mát, tránh ẩm ướt để ngăn chặn nấm mốc phát triển." },
  { title: "Vệ sinh sau khi sử dụng", text: "Lau chùi nhẹ nhàng sau khi sử dụng để loại bỏ bụi bẩn, giúp giày luôn sạch và không bị mùi hôi." },
] as const;

export const SHOE_CLEANING_GUIDANCE = [
  { title: "Dùng bàn chải mềm", text: "Tuyệt đối không dùng bàn chải cứng để chà rửa. Hãy dùng bàn chải lông mềm hoặc khăn ẩm để lau chùi bề mặt giày." },
  { title: "Hạn chế chất tẩy", text: "Không dùng chất tẩy mạnh (như thuốc tẩy quần áo) đổ trực tiếp vào giày, đặc biệt là với các dòng giày màu." },
  { title: "Dùng dung dịch chuyên dụng", text: "Sử dụng các chai tẩy trắng giày như Plac để làm sạch các vết bẩn cứng đầu một cách an toàn và hiệu quả." },
  { title: "Bảo vệ khi trời mưa", text: "Nên sử dụng chai xịt chống thấm nano (ví dụ: EYKOSI) để tạo lớp màng bảo vệ giày khỏi nước mưa và bùn đất." },
  { title: "Vệ sinh thường xuyên", text: "Đừng đợi đến khi giày quá bẩn mới giặt. Vệ sinh định kỳ giúp tăng tuổi thọ và giữ form giày lâu hơn." },
] as const;

export type ShoeCustomerReferenceProduct = {
  sku?: string;
  gender?: string | null;
  name?: string | null;
  category?: string | null;
  sizes?: readonly string[] | null;
  colors?: readonly string[] | null;
};

export type CustomerCopy = { title?: string; body: string; hashtags?: readonly string[] };
export type CustomerCopyViolation = "CONTENT_PRICE_FORBIDDEN" | "CONTENT_INTERNAL_TEXT_FORBIDDEN" | "CONTENT_WORD_LIMIT_EXCEEDED";

export class ShoeContentPolicyError extends Error {
  constructor(public readonly code: CustomerCopyViolation) {
    super(code);
    this.name = "ShoeContentPolicyError";
  }
}

function normalizedForPolicy(text: string) {
  return text.normalize("NFKC").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .toLowerCase();
}

export function customerCopyWordCount(text: string) {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

export function hasPriceDisclosure(text: string) {
  const normalized = normalizedForPolicy(text);
  const amount = "\\d{1,12}(?:[.,]\\d{1,3}){0,4}(?:[ \\u00a0]\\d{3}){0,4}";
  const moneyUnit = "(?:vnd|vndong|dong|usd|eur|gbp|jpy|cny|rmb|aud|cad|sgd|k|nghin|ngan|trieu|tr|ty)";
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${amount}\\s*(?:${moneyUnit}\\b|[₫$€£¥])`, "u").test(normalized)
    || new RegExp(`(?:^|[^\\p{L}\\p{N}_])${amount}\\s*[đĐ₫](?![\\p{L}\\p{N}])`, "u").test(text.normalize("NFKC").replace(/[\u200b-\u200f\u2060-\u206f\ufeff]/g, ""))
    || /(?:^|[^\p{L}\p{N}_])\d{3,}(?:[.,]\d+)*\s*d\b/u.test(normalized)
    || new RegExp(`(?:[₫$€£¥]|\\b(?:vnd|usd|eur|gbp|jpy|cny|rmb|aud|cad|sgd))\\s*${amount}`, "u").test(normalized)
    || /\bgia\s*[:=]|\bgia\s+(?:(?:la\s+)?\d|(?:ban|goc|tham khao|niem yet|khuyen mai|uu dai|chi|tu|sale|le|si)\b)|\b(?:sale\s+price|price|msrp)\s*[:=]/u.test(normalized)
    || /\b(?:bao gia|hoi gia|nhan gia|giam gia)\b/u.test(normalized)
    || /\b(?:giam(?:\s+gia)?|chiet khau|uu dai)\s+\d+(?:[.,]\d+)?\s*%/u.test(normalized)
    || /\b(?:nghin|ngan|trieu|ty)\s+(?:dong|vnd)\b/u.test(normalized)
    || /#(?:gia|price|sale)[^\s#]*\d/u.test(normalized)
    // Grouped amounts without a currency are also prices unless accompanied by
    // a physical unit. Decimal size ranges such as 21.6–22.5 do not match.
    || /(?:^|[^\p{L}\p{N}_.,])\d{1,3}(?:[.,]\d{3})+(?![\p{L}\p{N}_.,]|\s*(?:mm|cm|km|m|kg|g|mg|ml|l|%)\b)/u.test(normalized);
}

export function hasForbiddenInternalText(text: string) {
  const normalized = normalizedForPolicy(text);
  return /\b(?:google\s*)?(?:drive|sheets?)\b/u.test(normalized)
    || /\b(?:kiem tra|doi chieu|xac nhan)\s+(?:(?:lai|dung)\s+)*(?:ma(?:\s+san pham)?|sku|thuong hieu)\b/u.test(normalized)
    || /\b(?:anh|hinh anh|bai viet|noi dung)\s+(?:duoc\s+)?(?:tao|viet|sinh)\s+(?:boi|bang|tu)\s+ai\b/u.test(normalized)
    || /\b(?:anh|hinh anh|bai viet|noi dung)\s+(?:la\s+)?do\s+ai\b|\bai\s+(?:tao|viet|sinh)\b/u.test(normalized)
    || /\b(?:nguon anh|nguon du lieu|quy trinh ai|he thong tu dong|du lieu tu bang tinh)\b/u.test(normalized);
}

export function customerCopyViolation(copy: CustomerCopy): CustomerCopyViolation | null {
  const text = [copy.title ?? "", copy.body, ...(copy.hashtags ?? [])].join("\n");
  if (hasPriceDisclosure(text)) return "CONTENT_PRICE_FORBIDDEN";
  if (hasForbiddenInternalText(text)) return "CONTENT_INTERNAL_TEXT_FORBIDDEN";
  if (customerCopyWordCount(text) > MAX_CUSTOMER_POST_WORDS) return "CONTENT_WORD_LIMIT_EXCEEDED";
  return null;
}

export function assertCustomerCopyAllowed(copy: CustomerCopy) {
  const violation = customerCopyViolation(copy);
  if (violation) throw new ShoeContentPolicyError(violation);
}

export function sanitizeProductTextForCopy(text: string) {
  return text.split(/(?:\r?\n|[;|•]|\.(?=\s|$)|[!?](?=\s|$)|,(?=\s*[^\d\s]))+/u)
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase && !hasPriceDisclosure(phrase) && !hasForbiddenInternalText(phrase))
    .join("\n");
}

export function shoeSizeAudience(product: ShoeCustomerReferenceProduct): "female" | "male" | "both" {
  const text = normalizedForPolicy(product.gender?.trim() || `${product.name ?? ""} ${product.category ?? ""}`)
    .replace(/\bviet\s+nam\b/g, "");
  if (/\bunisex\b|\bca nam va nu\b/u.test(text)) return "both";
  const female = /\b(?:nu|female|woman|women|womens)\b/u.test(text);
  const male = /\b(?:nam|male|man|men|mens)\b/u.test(text);
  return female === male ? "both" : female ? "female" : "male";
}

const CUSTOMER_CARE_HEADING = "🧼 VỆ SINH & BẢO QUẢN";

export function shoeCustomerReferenceText(product: ShoeCustomerReferenceProduct = {}) {
  const audience = shoeSizeAudience(product);
  const availableSizes = [...new Set((product.sizes ?? [])
    .map((value) => String(value).normalize("NFKC").trim())
    .filter(Boolean))];
  const numericSizes = new Set(availableSizes.filter((value) => /^\d{2}$/u.test(value)).map(Number));
  const colors = [...new Set((product.colors ?? [])
    .map((value) => String(value).normalize("NFKC").trim())
    .filter(Boolean))];
  const sizeTables = (["female", "male"] as const).filter((gender) => audience === "both" || audience === gender)
    .map((gender) => {
      const rows = SHOE_SIZE_CHART[gender].filter((row) => numericSizes.has(row.size));
      if (!rows.length) return "";
      return [
        `${gender === "female" ? "Nữ" : "Nam"} — size VN/EU → chiều dài chân (cm):`,
        ...rows.map((row) => `${row.size} → ${row.minCm}–${row.maxCm}`),
      ].join("\n");
    }).filter(Boolean);
  return [
    ...(product.sku ? [`🏷️ Mã sản phẩm: ${product.sku}`] : []),
    ...(colors.length ? [`🎨 Màu: ${colors.join(", ")}`] : []),
    ...(availableSizes.length ? [`📏 Size hiện có: ${availableSizes.join(", ")}`] : []),
    "",
    CUSTOMER_CARE_HEADING,
    "• Lau nhẹ sau mỗi lần dùng; vệ sinh định kỳ bằng bàn chải lông mềm hoặc khăn ẩm.",
    "• Dùng dung dịch vệ sinh phù hợp chất liệu; tránh bàn chải cứng, chất tẩy mạnh, dầu mỡ và chất kết dính.",
    "• Không ngâm lâu, không để gần lửa hoặc nguồn nhiệt lớn; tránh phơi dưới nắng gắt kéo dài.",
    "• Cất giày ở nơi khô ráo, thoáng mát. Khi đi mưa, có thể dùng xịt bảo vệ phù hợp chất liệu theo hướng dẫn nhà sản xuất.",
    "",
    "📏 CHỌN SIZE THEO CHIỀU DÀI CHÂN",
    ...sizeTables.flatMap((table, index) => index ? ["", table] : [table]),
    "💬 Nhắn TAHA SHOES chiều dài chân để được tư vấn size phù hợp.",
  ].join("\n");
}

export function appendShoeCustomerReference(body: string, product: ShoeCustomerReferenceProduct = {}) {
  const trimmed = body.trim();
  const reference = shoeCustomerReferenceText(product);
  if (trimmed.endsWith(reference)) return trimmed;
  return `${trimmed}\n\n${reference}`;
}

export function hasWaterResistanceClaim(text: string) {
  const normalized = normalizedForPolicy(text)
    .replace(/\b(?:chai\s+)?xit[^.!?\n;]{0,40}\b(?:chong[ _-]?tham|chong[ _-]?nuoc)\b/gu, "")
    .replace(/\b(?:khong|chua)[^.!?\n;]{0,45}\b(?:chong[ _-]?tham|chong[ _-]?nuoc)\b/gu, "")
    .replace(/\b(?:not|non)[ -]?(?:waterproof|water[ -]resistant)\b/gu, "");
  return /\b(?:chong[ _-]?tham|chong[ _-]?nuoc|waterproof|water[ -]resistant)\b/u.test(normalized);
}
