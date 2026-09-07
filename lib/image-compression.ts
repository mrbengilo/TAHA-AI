import { getRuntimeEnv } from "./integrations/env";

export const ORIGINAL_IMAGE_MAX_BYTES = 300_000;
export const GENERATED_IMAGE_MAX_BYTES = 200_000;
export const IMAGE_COMPRESSION_POLICY = "taha-jpeg-v1";
export const LIFESTYLE_PROMPT_VERSION = "taha-lifestyle-v3";
export const LIFESTYLE_VARIANTS = ["cycling", "running", "climbing", "stream"] as const;

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_DIMENSION = 12_000;
const MAX_PIXELS = 40_000_000;

type ImageBinding = Pick<ImagesBinding, "info" | "input">;

const CANDIDATES = [
  [1600, 82], [1600, 72], [1400, 76], [1280, 70], [1152, 66], [1024, 62],
  [896, 58], [768, 54], [640, 50], [512, 46],
] as const;

function imageBinding(override?: ImageBinding) {
  const binding = override ?? getRuntimeEnv().IMAGES;
  if (!binding) throw new Error("IMAGE_TRANSFORM_UNAVAILABLE");
  return binding;
}

async function bytesOf(stream: ReadableStream<Uint8Array>, contentType: string) {
  const buffer = await new Response(stream, { headers: { "content-type": contentType } }).arrayBuffer();
  return new Blob([buffer], { type: contentType });
}

export async function compressImageToJpeg(
  source: Blob,
  ceilingBytes: number,
  override?: ImageBinding,
) {
  if (!(source instanceof Blob) || source.size < 1 || source.size > MAX_INPUT_BYTES) throw new Error("IMAGE_INPUT_INVALID");
  if (!Number.isInteger(ceilingBytes) || ceilingBytes < 10_000 || ceilingBytes > ORIGINAL_IMAGE_MAX_BYTES) {
    throw new Error("IMAGE_COMPRESSION_LIMIT_INVALID");
  }
  const binding = imageBinding(override);
  let info: Awaited<ReturnType<ImageBinding["info"]>>;
  try {
    info = await binding.info(source.stream());
  } catch {
    throw new Error("IMAGE_DECODE_FAILED");
  }
  if (!("width" in info) || !Number.isInteger(info.width) || !Number.isInteger(info.height)
    || info.width < 1 || info.height < 1 || info.width > MAX_DIMENSION || info.height > MAX_DIMENSION
    || info.width * info.height > MAX_PIXELS || !String(info.format).startsWith("image/")
    || info.format === "image/svg+xml") throw new Error("IMAGE_INPUT_INVALID");

  for (const [maxDimension, quality] of CANDIDATES) {
    const scale = Math.min(1, maxDimension / Math.max(info.width, info.height));
    const width = Math.max(1, Math.round(info.width * scale));
    const height = Math.max(1, Math.round(info.height * scale));
    let output;
    try {
      output = await binding.input(source.stream())
        .transform({ width, height, fit: "scale-down" })
        .output({ format: "image/jpeg", quality, background: "#ffffff", anim: false });
    } catch {
      throw new Error("IMAGE_ENCODE_FAILED");
    }
    const blob = await bytesOf(output.image(), "image/jpeg");
    if (blob.size > 0 && blob.size < ceilingBytes) {
      return { blob, mimeType: "image/jpeg" as const, width, height, quality, source: info };
    }
  }
  throw new Error("IMAGE_COMPRESSION_TARGET_UNREACHABLE");
}
