// Structure approved by the store owner, from the actual 28 August reference.
// Product facts from that post must never become defaults for another SKU.
export const FACEBOOK_REFERENCE_POST_URL = "https://www.facebook.com/122121496599193948/posts/122120254731193948";

export const FACEBOOK_CONTENT_INSTRUCTIONS = [
  "Riêng Facebook: học bố cục và giọng điệu của bài TAHA SHOES ngày 28/08/2026 đã được duyệt. Viết một câu mở đầu nêu điểm nhận diện thật của sản phẩm, sau đó đủ ba đoạn theo đúng thứ tự với nhãn Thiết kế:, Ưu điểm:, Ứng dụng:.",
  "Mỗi đoạn phải giải thích một ý riêng bằng câu hoàn chỉnh: Thiết kế mô tả hình dáng/chất liệu/chi tiết đã có trong dữ liệu; Ưu điểm giải thích lợi ích có căn cứ của những chi tiết đó; Ứng dụng gợi ý cách phối đồ hoặc sử dụng phù hợp với danh mục đã xác nhận. Không chỉ viết tên sản phẩm, SKU, size rồi mời nhắn tin; không để nhãn trống hoặc lặp một câu cho cả ba phần.",
  "Nếu dữ liệu không xác nhận chất liệu, công nghệ đế hay công dụng chuyên dụng thì không tự bổ sung; khai thác những đặc điểm có thật trong tên, mô tả, danh mục và thông số của chính sản phẩm. Không sao chép SKU PH0073, size 40–45, màu đen, kiểu chunky hoặc công dụng gym từ bài mẫu sang sản phẩm khác.",
  "Sau ba đoạn là khối thông tin sản phẩm, quà tặng nếu có, đóng gói, bảo hành nếu có, giao hàng/đổi size, kiểm tra hàng/COD và liên hệ cửa hàng. Hệ thống sẽ nối những khối này cùng hướng dẫn chăm sóc từ dữ liệu đã xác minh; không tự viết lại các khối đó, số điện thoại, chính sách, size hoặc màu trong body Facebook. Hashtag chỉ đặt trong trường hashtags để hiển thị cuối bài.",
].join("\n");

const FACEBOOK_SECTION_LABELS = ["Thiết kế", "Ưu điểm", "Ứng dụng"] as const;

function sectionText(value: string) {
  return value.replace(/[\p{P}\p{S}\s]/gu, "").toLocaleLowerCase("vi-VN");
}

export function hasCompleteFacebookStructure(body: string) {
  const sections = [...body.matchAll(/^[\t \p{P}\p{S}]*(Thiết kế|Ưu điểm|Ứng dụng)[\t *]*:[\t *]*/gimu)];
  if (sections.length !== FACEBOOK_SECTION_LABELS.length) return false;
  if (!sections.every((section, index) => section[1].toLocaleLowerCase("vi-VN") === FACEBOOK_SECTION_LABELS[index].toLocaleLowerCase("vi-VN"))) return false;
  // An opening hook and all three distinct sections are required before appendices
  // are added. The store footer cannot disguise an empty product description.
  if (!/\p{L}/u.test(body.slice(0, sections[0].index))) return false;
  const descriptions = sections.map((section, index) => body.slice(
    section.index! + section[0].length,
    sections[index + 1]?.index ?? body.length,
  ).trim());
  // A label followed by a single adjective is not a description. Check each
  // section, rather than rewarding a long generic footer or padded whole post.
  return descriptions.every((description) => (description.match(/\p{L}+/gu)?.length ?? 0) >= 8)
    && new Set(descriptions.map(sectionText)).size === descriptions.length;
}

type FacebookStoreProduct = {
  name?: string | null;
  description?: string | null;
  gifts?: readonly string[] | null;
  specifications?: readonly string[] | null;
};

export function facebookStoreReferenceText(product: FacebookStoreProduct) {
  const source = [product.name ?? "", product.description ?? "", ...(product.specifications ?? [])].join("\n");
  const clauses = source.split(/[\n.;!?]/u);
  const warrantySource = clauses.filter((clause) => !/(?:không|chưa|hết)\s+(?:có\s+)?bảo\s*hành/iu.test(clause)).join("\n");
  const giftSource = clauses.filter((clause) => !/(?:không|chưa|hết)\s+(?:có\s+)?(?:quà\s*tặng|tặng\s*kèm)/iu.test(clause)).join("\n");
  const warranty = warrantySource.match(/bảo\s*hành\s*:?\s*(\d{1,2})\s*tháng/iu)?.[1];
  const explicitGiftText = giftSource.match(/(?:quà\s*tặng|tặng\s*kèm)\s*[:-]?\s*([^\n.;]+)/iu)?.[1] ?? "";
  const gifts = [...new Set((product.gifts?.length ? product.gifts : [
    ...(/khử\s*mùi/iu.test(explicitGiftText) ? ["khử mùi"] : []),
    ...(/(?:vớ|tất)\s*thể\s*thao/iu.test(explicitGiftText) ? ["vớ thể thao"] : []),
  ]).map((gift) => gift.trim()).filter(Boolean))];
  return [
    "🛍️ MUA SẮM CÙNG TAHA SHOES",
    ...(gifts.length ? [`🎁 Quà tặng kèm: ${gifts.join(" + ")}.`] : []),
    "📦 Mỗi sản phẩm được đóng gói bằng bọc chống sốc và hộp bảo vệ.",
    ...(warranty ? [`🛡️ Bảo hành ${warranty} tháng.`] : []),
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
}
