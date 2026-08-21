export type TikTokProductVariantSnapshot = {
  id: string;
  sku: string;
  priceMinor: number;
  inventoryQuantity: number;
};

export type TikTokProductSnapshot = {
  id: string;
  name: string;
  description: string;
  currency: string;
  variants: TikTokProductVariantSnapshot[];
};

type TikTokSalesAttribute = {
  id: string;
  name?: string;
  value_id?: string;
  value_name?: string;
  sku_img?: { uri: string };
};

export type TikTokListingConfig = {
  categoryId: string;
  categoryVersion: "v2";
  warehouseId: string;
  packageWeight: Record<string, unknown>;
  brandId?: string;
  productAttributes?: Array<Record<string, unknown>>;
  salesAttributesBySku?: Record<string, TikTokSalesAttribute[]>;
  saveMode?: "AS_DRAFT" | "LISTING";
};

export type TikTokListingPreflightIssue = {
  code: string;
  field: string;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function parseTikTokListingConfig(platformData: unknown): TikTokListingConfig | null {
  const root = object(platformData);
  const raw = object(root.tiktokShop);
  const categoryId = text(raw.categoryId);
  const warehouseId = text(raw.warehouseId);
  const packageWeight = object(raw.packageWeight);
  if (!categoryId && !warehouseId && Object.keys(packageWeight).length === 0) return null;
  const rawAttributes = Array.isArray(raw.productAttributes) ? raw.productAttributes : [];
  const rawSalesAttributes = object(raw.salesAttributesBySku);
  const salesAttributesBySku = Object.fromEntries(Object.entries(rawSalesAttributes).flatMap(([sku, value]) => (
    Array.isArray(value) ? [[sku, value.map(object) as TikTokSalesAttribute[]]] : []
  )));
  const saveMode = raw.saveMode === "LISTING" ? "LISTING" : "AS_DRAFT";
  return {
    categoryId,
    categoryVersion: raw.categoryVersion === "v2" ? "v2" : "v2",
    warehouseId,
    packageWeight,
    brandId: text(raw.brandId) || undefined,
    productAttributes: rawAttributes.map(object),
    salesAttributesBySku,
    saveMode,
  };
}

export function preflightTikTokListing(input: {
  product: TikTokProductSnapshot;
  config: TikTokListingConfig | null;
  imageUris: string[];
}) {
  const issues: TikTokListingPreflightIssue[] = [];
  const { product, config } = input;
  if (!config) issues.push({ code: "TIKTOK_LISTING_CONFIG_REQUIRED", field: "platformData.tiktokShop" });
  if (!config?.categoryId) issues.push({ code: "TIKTOK_CATEGORY_REQUIRED", field: "categoryId" });
  if (!config?.warehouseId) issues.push({ code: "TIKTOK_WAREHOUSE_REQUIRED", field: "warehouseId" });
  if (!positiveNumber(config?.packageWeight.value)) issues.push({ code: "TIKTOK_PACKAGE_WEIGHT_REQUIRED", field: "packageWeight.value" });
  if (!text(config?.packageWeight.unit)) issues.push({ code: "TIKTOK_PACKAGE_WEIGHT_UNIT_REQUIRED", field: "packageWeight.unit" });
  if (product.name.trim().length < 25 || product.name.trim().length > 255) {
    issues.push({ code: "TIKTOK_TITLE_LENGTH_INVALID", field: "product.name" });
  }
  if (!product.description.trim() || product.description.length > 10_000) {
    issues.push({ code: "TIKTOK_DESCRIPTION_INVALID", field: "product.description" });
  }
  if (!/^[A-Z]{3}$/.test(product.currency)) issues.push({ code: "TIKTOK_CURRENCY_INVALID", field: "product.currency" });
  if (input.imageUris.length < 1 || input.imageUris.length > 9 || input.imageUris.some((uri) => !text(uri))) {
    issues.push({ code: "TIKTOK_MAIN_IMAGES_INVALID", field: "mainImages" });
  }
  if (product.variants.length < 1 || product.variants.length > 100) {
    issues.push({ code: "TIKTOK_VARIANTS_INVALID", field: "product.variants" });
  }
  for (const variant of product.variants) {
    if (!variant.sku.trim() || variant.sku.length > 100) issues.push({ code: "TIKTOK_SKU_INVALID", field: `variants.${variant.id}.sku` });
    if (!Number.isSafeInteger(variant.priceMinor) || variant.priceMinor <= 0) issues.push({ code: "TIKTOK_PRICE_INVALID", field: `variants.${variant.id}.priceMinor` });
    if (!Number.isSafeInteger(variant.inventoryQuantity) || variant.inventoryQuantity < 0) issues.push({ code: "TIKTOK_INVENTORY_INVALID", field: `variants.${variant.id}.inventoryQuantity` });
    if (product.variants.length > 1 && (config?.salesAttributesBySku?.[variant.sku]?.length ?? 0) === 0) {
      issues.push({ code: "TIKTOK_SALES_ATTRIBUTES_REQUIRED", field: `salesAttributesBySku.${variant.sku}` });
    }
  }
  return issues;
}

export class TikTokListingConfigurationError extends Error {
  constructor(public readonly issues: TikTokListingPreflightIssue[]) {
    super(issues[0]?.code || "TIKTOK_LISTING_CONFIG_INVALID");
    this.name = "TikTokListingConfigurationError";
  }
}

export function buildTikTokCreateProductBody(input: {
  product: TikTokProductSnapshot;
  config: TikTokListingConfig;
  imageUris: string[];
}) {
  const issues = preflightTikTokListing(input);
  if (issues.length > 0) throw new TikTokListingConfigurationError(issues);
  const { product, config } = input;
  return {
    save_mode: config.saveMode ?? "AS_DRAFT",
    title: product.name.trim(),
    description: product.description.trim(),
    category_id: config.categoryId,
    category_version: config.categoryVersion,
    ...(config.brandId ? { brand_id: config.brandId } : {}),
    main_images: input.imageUris.map((uri) => ({ uri })),
    package_weight: config.packageWeight,
    ...(config.productAttributes?.length ? { product_attributes: config.productAttributes } : {}),
    skus: product.variants.map((variant) => ({
      seller_sku: variant.sku,
      external_sku_id: variant.id,
      price: { amount: String(variant.priceMinor), currency: product.currency },
      inventory: [{ warehouse_id: config.warehouseId, quantity: variant.inventoryQuantity }],
      ...(product.variants.length > 1
        ? { sales_attributes: config.salesAttributesBySku?.[variant.sku] ?? [] }
        : {}),
    })),
    external_product_id: product.id,
  };
}
