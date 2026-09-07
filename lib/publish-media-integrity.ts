import { LIFESTYLE_PROMPT_VERSION, LIFESTYLE_VARIANTS, MAX_POST_IMAGES } from "./image-compression";
import { assertGeneratedProductMedia, assertProductMedia, type ProductDatabase } from "./product-integrity";

export async function assertPublishProductMedia(
  productId: string,
  mediaIds: string[],
  platformData: Record<string, unknown>,
  database?: ProductDatabase,
) {
  const fingerprint = typeof platformData.sourceFingerprint === "string" ? platformData.sourceFingerprint : undefined;
  const sourceImageCount = Number(platformData.sourceImageCount || 0);
  const generatedImageCount = Number(platformData.generatedImageCount || 0);
  const legacyGeneratedOnly = generatedImageCount > 0 && mediaIds.length === generatedImageCount;
  if (legacyGeneratedOnly) {
    if (generatedImageCount > LIFESTYLE_VARIANTS.length || mediaIds.length > MAX_POST_IMAGES
      || platformData.imagePromptVersion !== LIFESTYLE_PROMPT_VERSION || !fingerprint) {
      throw new Error("PRODUCT_GENERATED_MEDIA_MISMATCH");
    }
    return assertGeneratedProductMedia(productId, mediaIds, fingerprint,
      LIFESTYLE_PROMPT_VERSION, LIFESTYLE_VARIANTS.slice(0, generatedImageCount), database);
  }
  if (!Number.isInteger(sourceImageCount) || sourceImageCount < 1
    || !Number.isInteger(generatedImageCount) || generatedImageCount < 0 || generatedImageCount > LIFESTYLE_VARIANTS.length
    || sourceImageCount + generatedImageCount !== mediaIds.length || mediaIds.length > MAX_POST_IMAGES) {
    throw new Error("PRODUCT_MEDIA_MISMATCH");
  }
  const sourceMediaIds = mediaIds.slice(0, sourceImageCount);
  const generatedMediaIds = mediaIds.slice(sourceImageCount);
  const sources = await assertProductMedia(productId, sourceMediaIds, fingerprint, database);
  if (!generatedImageCount) return sources;
  if (platformData.imagePromptVersion !== LIFESTYLE_PROMPT_VERSION || !fingerprint) {
    throw new Error("PRODUCT_GENERATED_MEDIA_MISMATCH");
  }
  return assertGeneratedProductMedia(productId, generatedMediaIds, fingerprint,
    LIFESTYLE_PROMPT_VERSION, LIFESTYLE_VARIANTS.slice(0, generatedImageCount), database);
}
