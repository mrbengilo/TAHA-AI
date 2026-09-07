import { LIFESTYLE_PROMPT_VERSION, LIFESTYLE_VARIANTS } from "./image-compression";
import { assertGeneratedProductMedia, assertProductMedia, type ProductDatabase } from "./product-integrity";

export async function assertPublishProductMedia(
  productId: string,
  mediaIds: string[],
  platformData: Record<string, unknown>,
  database?: ProductDatabase,
) {
  const fingerprint = typeof platformData.sourceFingerprint === "string" ? platformData.sourceFingerprint : undefined;
  if (Number(platformData.generatedImageCount || 0) !== 0) {
    if (platformData.generatedImageCount !== 4 || platformData.imagePromptVersion !== LIFESTYLE_PROMPT_VERSION || !fingerprint) {
      throw new Error("PRODUCT_GENERATED_MEDIA_MISMATCH");
    }
    return assertGeneratedProductMedia(productId, mediaIds, fingerprint, LIFESTYLE_PROMPT_VERSION, LIFESTYLE_VARIANTS, database);
  }
  return assertProductMedia(productId, mediaIds, fingerprint, database);
}
