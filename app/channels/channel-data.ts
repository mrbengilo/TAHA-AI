export const channelIds = [
  "google_drive",
  "google_sheets",
  "facebook",
  "zalo_personal",
  "tiktok_shop",
  "shopee",
  "website",
] as const;

export type ChannelId = (typeof channelIds)[number];
export type ChannelGroup = "source" | "social" | "commerce" | "owned";

export type ChannelDefinition = {
  id: ChannelId;
  name: string;
  compactName: string;
  eyebrow: string;
  description: string;
  group: ChannelGroup;
  mark: string;
  accent: string;
  softAccent: string;
  supportsDrafts: boolean;
  supportsSync: boolean;
  connectionProvider: "google" | "facebook" | "zalo_personal" | "tiktok_shop" | "shopee" | "website";
};

export const channelDefinitions: Record<ChannelId, ChannelDefinition> = {
  google_drive: {
    id: "google_drive",
    name: "Google Drive",
    compactName: "Drive",
    eyebrow: "KHO HÌNH ẢNH GỐC",
    description: "Theo dõi ảnh sản phẩm trong thư mục Drive và đồng bộ chúng vào kho nội dung.",
    group: "source",
    mark: "D",
    accent: "#206b4f",
    softAccent: "#e9f5ef",
    supportsDrafts: true,
    supportsSync: true,
    connectionProvider: "google",
  },
  google_sheets: {
    id: "google_sheets",
    name: "Google Sheets",
    compactName: "Sheets",
    eyebrow: "DỮ LIỆU SẢN PHẨM",
    description: "Đọc tên, SKU, mô tả, giá và tồn kho từ bảng tính nguồn.",
    group: "source",
    mark: "S",
    accent: "#18865b",
    softAccent: "#e8f8f0",
    supportsDrafts: true,
    supportsSync: true,
    connectionProvider: "google",
  },
  facebook: {
    id: "facebook",
    name: "Facebook Page",
    compactName: "Facebook",
    eyebrow: "NỘI DUNG MẠNG XÃ HỘI",
    description: "Lưu bài viết, hình ảnh, lịch đăng và kết quả xuất bản riêng cho Facebook Page.",
    group: "social",
    mark: "f",
    accent: "#1769e0",
    softAccent: "#eaf2ff",
    supportsDrafts: true,
    supportsSync: false,
    connectionProvider: "facebook",
  },
  zalo_personal: {
    id: "zalo_personal",
    name: "Zalo cá nhân",
    compactName: "Zalo",
    eyebrow: "ĐĂNG BÀI CÓ XÁC NHẬN",
    description: "Chuẩn bị caption và bộ ảnh riêng; bạn là người xác nhận và đăng từ tài khoản cá nhân.",
    group: "social",
    mark: "Z",
    accent: "#0868f2",
    softAccent: "#eaf3ff",
    supportsDrafts: true,
    supportsSync: false,
    connectionProvider: "zalo_personal",
  },
  tiktok_shop: {
    id: "tiktok_shop",
    name: "TikTok Shop",
    compactName: "TikTok",
    eyebrow: "GIAN HÀNG VIDEO",
    description: "Quản lý nội dung listing, hình ảnh, trạng thái và lần đồng bộ của TikTok Shop.",
    group: "commerce",
    mark: "T",
    accent: "#18181b",
    softAccent: "#f0f0f2",
    supportsDrafts: true,
    supportsSync: false,
    connectionProvider: "tiktok_shop",
  },
  shopee: {
    id: "shopee",
    name: "Shopee Seller",
    compactName: "Shopee",
    eyebrow: "GIAN HÀNG SÀN TMĐT",
    description: "Quản lý nội dung sản phẩm, bộ ảnh, SKU và trạng thái đồng bộ riêng cho Shopee.",
    group: "commerce",
    mark: "S",
    accent: "#e84b2c",
    softAccent: "#fff0ec",
    supportsDrafts: true,
    supportsSync: false,
    connectionProvider: "shopee",
  },
  website: {
    id: "website",
    name: "Website bán hàng",
    compactName: "Website",
    eyebrow: "KÊNH SỞ HỮU",
    description: "Lưu bài viết, nội dung sản phẩm, hình ảnh và lịch sử gửi sang website của bạn.",
    group: "owned",
    mark: "W",
    accent: "#76542e",
    softAccent: "#f6efe5",
    supportsDrafts: true,
    supportsSync: false,
    connectionProvider: "website",
  },
};

export function isChannelId(value: string): value is ChannelId {
  return channelIds.includes(value as ChannelId);
}

export function statusLabel(status: string) {
  const labels: Record<string, string> = {
    connected: "Đã kết nối",
    assisted: "Có xác nhận",
    ready: "Sẵn sàng",
    pending: "Chờ thiết lập",
    disconnected: "Chưa kết nối",
    not_connected: "Chưa kết nối",
    error: "Cần kiểm tra",
    expired: "Hết phiên",
    disabled: "Đã tắt",
  };
  return labels[status] ?? status;
}

export function contentStatusLabel(status: string) {
  const labels: Record<string, string> = {
    draft: "Bản nháp",
    in_review: "Chờ duyệt",
    approved: "Đã duyệt",
    rejected: "Cần sửa",
    archived: "Đã lưu trữ",
    queued: "Trong hàng đợi",
    awaiting_confirmation: "Chờ xác nhận",
    publishing: "Đang đăng",
    retry_wait: "Sẽ thử lại",
    blocked: "Đang bị chặn",
    published: "Đã đăng",
    failed: "Đăng lỗi",
    cancelled: "Đã hủy",
    ready: "Sẵn sàng",
    processing: "Đang xử lý",
    pending: "Đang chờ",
  };
  return labels[status] ?? status;
}

export function formatDate(value: number | string | null | undefined) {
  if (!value) return "Chưa có hoạt động";
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date(value));
}
