import type { SourceProduct } from "./product-integrity";

export const WEBSITE_PRODUCT_SCHEMA_VERSION = "taha.website.product.v1";

type WebsiteMetricInput = {
  rating?: unknown;
  reviewCount?: unknown;
  soldCount?: unknown;
};

type WebsiteProductMetadata = WebsiteMetricInput & {
  secondHand?: unknown;
  costPriceMinor?: unknown;
  discountPercent?: unknown;
  subcategory?: unknown;
  colors?: unknown;
  gifts?: unknown;
  sizes?: unknown;
  specifications?: unknown;
};

export type WebsiteMediaPayload = {
  filename: string;
  mimeType: string;
  dataBase64: string;
};

export type WebsiteProductPayloadInput = {
  jobId: string;
  idempotencyKey: string;
  product: SourceProduct;
  draft: {
    id: string;
    version: number;
    title?: unknown;
    body?: unknown;
    hashtags?: unknown;
    platformData?: unknown;
  };
  media: WebsiteMediaPayload[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, maxLength = 12_000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function stringList(value: unknown, maxItems = 50) {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;\n|]+/u) : [];
  return [...new Set(raw.map((item) => text(item, 160)).filter(Boolean))].slice(0, maxItems);
}

function optionalInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

function optionalRating(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 5) return undefined;
  return Math.round(value * 10) / 10;
}

function metadata(product: SourceProduct): WebsiteProductMetadata {
  let parsed: unknown = {};
  try { parsed = JSON.parse(product.metadata_json || "{}"); } catch { /* invalid legacy metadata is ignored */ }
  const root = record(parsed);
  return record(root.website) as WebsiteProductMetadata;
}

function shortDescription(source: string) {
  return source.split(/\r?\n/u)
    .filter((line) => !/^\s*(?:📏|🧼)/u.test(line))
    .map((line) => line.replace(/^[^\p{L}\p{N}]+/u, "").trim())
    .filter((line) => line.length >= 8 && !/^#/u.test(line))
    .slice(0, 5)
    .map((line) => `• ${line}`)
    .join("\n");
}

function slugify(value: string) {
  return value.replace(/[đĐ]/g, "d").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 220);
}

function specifications(value: unknown) {
  return Object.fromEntries(stringList(value, 80).map((item, index) => {
    const [rawKey, ...rest] = item.split(":");
    const key = text(rest.length ? rawKey : `Thông số ${index + 1}`, 100);
    return [key, text(rest.length ? rest.join(":") : item, 300)];
  }));
}

/**
 * Builds the versioned product-upsert contract consumed by tahashoes.vn.
 * Customer-facing counters are included only when they were explicitly
 * supplied by the catalog owner; absent counters are left for the website to
 * preserve on update or initialize truthfully on create.
 */
export function buildWebsiteProductPayload(input: WebsiteProductPayloadInput) {
  if (!input.media.length) {
    throw new Error("WEBSITE_PRODUCT_MEDIA_COUNT_INVALID");
  }
  const productMetadata = metadata(input.product);
  const platformData = record(input.draft.platformData);
  const sku = input.product.base_sku;
  const requestedTitle = text(input.draft.title, 300) || input.product.name;
  const title = requestedTitle.toLocaleUpperCase("vi-VN").includes(sku.toLocaleUpperCase("vi-VN"))
    ? requestedTitle : `${requestedTitle} - ${sku}`;
  const sizes = stringList(productMetadata.sizes, 30);
  if (!sizes.length) throw new Error("WEBSITE_PRODUCT_SIZES_REQUIRED");
  const detailedDescription = text(input.draft.body, 20_000)
    || text(platformData.productDescription, 20_000)
    || input.product.description;
  const rating = optionalRating(productMetadata.rating);
  const reviewCount = optionalInteger(productMetadata.reviewCount);
  const soldCount = optionalInteger(productMetadata.soldCount);
  const compareAtPriceMinor = optionalInteger(input.product.compare_at_price_minor);
  const currentPriceMinor = optionalInteger(input.product.price_minor) ?? 0;
  const calculatedDiscount = compareAtPriceMinor && compareAtPriceMinor > currentPriceMinor
    ? Math.round((1 - currentPriceMinor / compareAtPriceMinor) * 100)
    : 0;

  return {
    schemaVersion: WEBSITE_PRODUCT_SCHEMA_VERSION,
    operation: "upsert_product",
    tahaJobId: input.jobId,
    idempotencyKey: input.idempotencyKey,
    product: {
      sku,
      name: title,
      slug: slugify(title),
      isSecondHand: productMetadata.secondHand === true,
      brand: input.product.brand,
      category: input.product.category,
      subcategory: text(productMetadata.subcategory, 200) || null,
      price: currentPriceMinor,
      originalPrice: compareAtPriceMinor ?? currentPriceMinor,
      costPrice: optionalInteger(productMetadata.costPriceMinor) ?? 0,
      discount: optionalInteger(productMetadata.discountPercent) ?? calculatedDiscount,
      stock: optionalInteger(input.product.inventory_quantity) ?? 0,
      colors: stringList(productMetadata.colors, 30),
      gifts: stringList(productMetadata.gifts, 20),
      sizes,
      shortDescription: shortDescription(detailedDescription),
      description: detailedDescription,
      specifications: specifications(productMetadata.specifications),
      media: input.media.map((item, index) => ({
        role: index === 0 ? "primary" : "gallery",
        sortOrder: index,
        filename: item.filename,
        mimeType: item.mimeType,
        dataBase64: item.dataBase64,
      })),
      ...(rating === undefined ? {} : { rating }),
      ...(reviewCount === undefined ? {} : { reviewCount }),
      ...(soldCount === undefined ? {} : { soldCount }),
    },
    source: {
      system: "TAHA-AI",
      draftId: input.draft.id,
      draftVersion: input.draft.version,
    },
  };
}
