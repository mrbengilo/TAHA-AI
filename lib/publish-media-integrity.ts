import { assertProductMedia, type ProductDatabase } from "./product-integrity";

export async function assertPublishProductMedia(
  productId: string,
  mediaIds: string[],
  platformData: Record<string, unknown>,
  database?: ProductDatabase,
) {
  const fingerprint = typeof platformData.sourceFingerprint === "string" ? platformData.sourceFingerprint : undefined;
  const sourceImageCount = Number(platformData.sourceImageCount || 0);
  const generatedImageCount = Number(platformData.generatedImageCount || 0);
  if (generatedImageCount !== 0) throw new Error("PRODUCT_GENERATED_MEDIA_DISABLED");
  if (!Number.isInteger(sourceImageCount) || sourceImageCount < 1 || sourceImageCount !== mediaIds.length) {
    throw new Error("PRODUCT_MEDIA_MISMATCH");
  }
  return assertProductMedia(productId, mediaIds, fingerprint, database);
}
