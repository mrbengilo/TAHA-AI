import { env } from "cloudflare:workers";

export type RuntimeEnv = {
  DB?: D1Database;
  MEDIA?: R2Bucket;
  PUBLIC_APP_URL?: string;
  OAUTH_STATE_SECRET?: string;
  INTEGRATION_TOKEN_ENCRYPTION_KEY?: string;
  INTERNAL_API_SECRET?: string;
  TRUSTED_PROXY_SECRET?: string;
  SITES_OPERATOR_USER_IDS?: string;
  SITES_OPERATOR_EMAILS?: string;
  SITES_VIEWER_USER_IDS?: string;
  SITES_VIEWER_EMAILS?: string;
  GOOGLE_AUTH_MODE?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  GOOGLE_OAUTH_SCOPES?: string;
  GOOGLE_DRIVE_FOLDER_ID?: string;
  GOOGLE_SHEET_ID?: string;
  GOOGLE_SHEET_NAME?: string;
  GOOGLE_SHEET_RANGE?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON_B64?: string;
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_LOGIN_CONFIG_ID?: string;
  META_GRAPH_API_VERSION?: string;
  META_REDIRECT_URI?: string;
  SHOPEE_ENV?: string;
  SHOPEE_REGION?: string;
  SHOPEE_BASE_URL?: string;
  SHOPEE_PARTNER_ID?: string;
  SHOPEE_PARTNER_KEY?: string;
  SHOPEE_REDIRECT_URI?: string;
  TIKTOK_SHOP_MARKET?: string;
  TIKTOK_SHOP_APP_KEY?: string;
  TIKTOK_SHOP_APP_SECRET?: string;
  TIKTOK_SHOP_SERVICE_ID?: string;
  TIKTOK_SHOP_REDIRECT_URI?: string;
  TIKTOK_SHOP_API_BASE_URL?: string;
  TIKTOK_SHOP_AUTH_BASE_URL?: string;
  TIKTOK_SHOP_AUTHORIZE_URL?: string;
  ZALO_PERSONAL_MODE?: string;
  WEBSITE_BASE_URL?: string;
  WEBSITE_PUBLISH_ENDPOINT?: string;
  WEBSITE_WEBHOOK_SECRET?: string;
  OPENAI_API_KEY?: string;
  OPENAI_TEXT_MODEL?: string;
  OPENAI_IMAGE_MODEL?: string;
  OPENAI_IMAGE_QUALITY?: string;
};

export function getRuntimeEnv(): RuntimeEnv {
  return env as unknown as RuntimeEnv;
}

export function requireEnv(name: keyof RuntimeEnv): string {
  const value = getRuntimeEnv()[name];
  if (!value || typeof value !== "string") {
    throw new IntegrationConfigError(String(name));
  }
  return value;
}

export class IntegrationConfigError extends Error {
  constructor(public readonly variable: string) {
    super(`Thiếu cấu hình máy chủ: ${variable}`);
    this.name = "IntegrationConfigError";
  }
}
