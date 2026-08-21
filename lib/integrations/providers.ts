import { getRuntimeEnv, type RuntimeEnv } from "./env";

export const providerIds = [
  "google",
  "facebook",
  "zalo_personal",
  "shopee",
  "tiktok_shop",
  "website",
] as const;

export type ProviderId = (typeof providerIds)[number];

type ProviderDefinition = {
  id: ProviderId;
  name: string;
  shortName: string;
  description: string;
  role: "source" | "publisher" | "commerce" | "both";
  publishMode: "api" | "assisted" | "export_only";
  capabilities: string[];
  required: (keyof RuntimeEnv)[];
  optional?: (keyof RuntimeEnv)[];
  callbackPath?: string;
  setupUrl?: string;
  setupLabel?: string;
  accent: string;
  mark: string;
};

export const providerDefinitions: Record<ProviderId, ProviderDefinition> = {
  google: {
    id: "google",
    name: "Google Drive & Sheets",
    shortName: "Google",
    description: "Đọc ảnh từ thư mục Drive và thông tin sản phẩm từ Google Sheet.",
    role: "source",
    publishMode: "export_only",
    capabilities: ["Đọc thư mục ảnh", "Đọc bảng sản phẩm", "Đồng bộ thay đổi"],
    required: ["PUBLIC_APP_URL", "OAUTH_STATE_SECRET", "INTEGRATION_TOKEN_ENCRYPTION_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "GOOGLE_DRIVE_FOLDER_ID", "GOOGLE_SHEET_ID"],
    optional: ["GOOGLE_SHEET_NAME", "GOOGLE_SHEET_RANGE"],
    callbackPath: "/api/integrations/google/callback",
    setupUrl: "https://console.cloud.google.com/auth/clients",
    setupLabel: "Mở Google Cloud",
    accent: "#4285f4",
    mark: "G",
  },
  facebook: {
    id: "facebook",
    name: "Facebook Page",
    shortName: "Facebook",
    description: "Đăng bài, ảnh và theo dõi trạng thái xuất bản trên Trang.",
    role: "publisher",
    publishMode: "api",
    capabilities: ["Đăng bài tự động", "Đăng nhiều ảnh", "Lưu Post ID"],
    required: ["PUBLIC_APP_URL", "OAUTH_STATE_SECRET", "INTEGRATION_TOKEN_ENCRYPTION_KEY", "META_APP_ID", "META_APP_SECRET", "META_LOGIN_CONFIG_ID", "META_GRAPH_API_VERSION", "META_REDIRECT_URI"],
    callbackPath: "/api/integrations/facebook/callback",
    setupUrl: "https://developers.facebook.com/apps/",
    setupLabel: "Mở Meta for Developers",
    accent: "#1877f2",
    mark: "f",
  },
  zalo_personal: {
    id: "zalo_personal",
    name: "Zalo cá nhân",
    shortName: "Zalo",
    description: "Chuẩn bị caption và ảnh, sau đó yêu cầu chủ tài khoản xác nhận đăng.",
    role: "publisher",
    publishMode: "assisted",
    capabilities: ["Sao chép caption", "Tải bộ ảnh", "Xác nhận đã đăng"],
    required: [],
    optional: ["ZALO_PERSONAL_MODE"],
    setupUrl: "https://chat.zalo.me/",
    setupLabel: "Mở Zalo để đăng",
    accent: "#0068ff",
    mark: "Z",
  },
  shopee: {
    id: "shopee",
    name: "Shopee Seller",
    shortName: "Shopee",
    description: "Đồng bộ sản phẩm, phân loại, giá, tồn kho và ảnh lên Seller Center.",
    role: "commerce",
    publishMode: "api",
    capabilities: ["Đăng sản phẩm", "Đồng bộ giá", "Đồng bộ tồn kho"],
    required: ["PUBLIC_APP_URL", "OAUTH_STATE_SECRET", "INTEGRATION_TOKEN_ENCRYPTION_KEY", "SHOPEE_BASE_URL", "SHOPEE_PARTNER_ID", "SHOPEE_PARTNER_KEY", "SHOPEE_REDIRECT_URI"],
    callbackPath: "/api/integrations/shopee/callback",
    setupUrl: "https://open.shopee.com/",
    setupLabel: "Mở Shopee Open Platform",
    accent: "#ee4d2d",
    mark: "S",
  },
  tiktok_shop: {
    id: "tiktok_shop",
    name: "TikTok Shop",
    shortName: "TikTok Shop",
    description: "Đồng bộ listing, ảnh, SKU, giá và tồn kho của cửa hàng TikTok.",
    role: "commerce",
    publishMode: "api",
    capabilities: ["Đăng sản phẩm", "Đồng bộ giá", "Đồng bộ tồn kho"],
    required: ["PUBLIC_APP_URL", "OAUTH_STATE_SECRET", "INTEGRATION_TOKEN_ENCRYPTION_KEY", "TIKTOK_SHOP_APP_KEY", "TIKTOK_SHOP_APP_SECRET", "TIKTOK_SHOP_SERVICE_ID", "TIKTOK_SHOP_REDIRECT_URI"],
    callbackPath: "/api/integrations/tiktok-shop/callback",
    setupUrl: "https://partner.tiktokshop.com/",
    setupLabel: "Mở TikTok Shop Partner Center",
    accent: "#111111",
    mark: "T",
  },
  website: {
    id: "website",
    name: "Website bán hàng",
    shortName: "Website",
    description: "Gửi sản phẩm và bài viết đã duyệt đến website qua webhook bảo mật.",
    role: "both",
    publishMode: "api",
    capabilities: ["Đăng sản phẩm", "Đăng bài viết", "Đồng bộ tồn kho"],
    required: ["INTEGRATION_TOKEN_ENCRYPTION_KEY", "WEBSITE_BASE_URL", "WEBSITE_PUBLISH_ENDPOINT", "WEBSITE_WEBHOOK_SECRET"],
    accent: "#39755c",
    mark: "W",
  },
};

export function isProviderId(value: string): value is ProviderId {
  return providerIds.includes(value as ProviderId);
}

export function getProviderReadiness(provider: ProviderId) {
  const definition = providerDefinitions[provider];
  const runtime = getRuntimeEnv();
  const missing = definition.required.filter((key) => {
    const value = runtime[key];
    return typeof value !== "string" || value.trim() === "";
  });
  return {
    configured: missing.length === 0,
    missing: missing.map(String),
  };
}

export function safeProviderDefinition(provider: ProviderId) {
  const definition = providerDefinitions[provider];
  const readiness = getProviderReadiness(provider);
  return {
    id: definition.id,
    name: definition.name,
    shortName: definition.shortName,
    description: definition.description,
    role: definition.role,
    publishMode: definition.publishMode,
    capabilities: definition.capabilities,
    callbackPath: definition.callbackPath ?? null,
    setupUrl: definition.setupUrl ?? null,
    setupLabel: definition.setupLabel ?? null,
    accent: definition.accent,
    mark: definition.mark,
    ...readiness,
  };
}
