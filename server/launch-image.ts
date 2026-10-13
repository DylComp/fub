import sharp from "sharp";
import { createHash } from "node:crypto";
import { MAX_LAUNCH_IMAGE_BYTES } from "../src/launch-publication.js";
export async function normalizeLaunchImage(bytes: Buffer, type: string) {
  if (!bytes.length || bytes.length > MAX_LAUNCH_IMAGE_BYTES || !["image/png", "image/jpeg", "image/gif"].includes(type)) throw Error("Choose a PNG, JPG or GIF up to 2 MB.");
  const image = sharp(bytes, { animated: true, failOn: "warning", limitInputPixels: 16777216, unlimited: false }).timeout({ seconds: 5 });
  try {
    const meta = await image.metadata(), width = meta.width || 0, height = meta.pageHeight || meta.height || 0, pages = meta.pages || 1;
    const formats: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif" };
    if (!meta.format || formats[meta.format] !== type || width < 1 || height < 1 || pages > 60 || width * height * pages > 16777216) throw Error("Use a PNG, JPG or GIF with at most 60 frames and 16 million total pixels.");
    // Decode every frame and re-encode to remove EXIF, comments and trailing
    // payloads. Animated GIFs retain animation; no SVG/remote URL is accepted.
    if (type === "image/jpeg") image.rotate();
    image.resize(512, 512, { fit: "contain", background: { r: 11, g: 9, b: 21, alpha: type === "image/jpeg" ? 1 : 0 } });
    const output = type === "image/jpeg" ? await image.jpeg({ quality: 95 }).toBuffer() : type === "image/gif" ? await image.gif({ effort: 3 }).toBuffer() : await image.png().toBuffer();
    if (output.length > MAX_LAUNCH_IMAGE_BYTES) throw Error("The checked image exceeds 2 MB. Use a smaller image.");
    return { bytes: output, hash: createHash("sha256").update(output).digest("hex"), type, width: 512, height: 512, frames: pages };
  } finally { image.destroy(); }
}
