/**
 * Cloudflare Image Transformations cap animated GIF/WebP by the summed area of
 * every frame: above 50 MP the animation is served untransformed, above 100 MP
 * it is not served at all (decoims answers 403 "Upstream error"). The upload
 * itself succeeds either way, so without this check the break only shows up
 * on the storefront.
 * https://developers.cloudflare.com/images/get-started/limits/
 */
export const ANIMATED_AREA_WARN_MP = 50;
export const ANIMATED_AREA_MAX_MP = 100;

export interface AnimatedImageArea {
  width: number;
  height: number;
  frames: number;
  /** width × height × frames, in megapixels. */
  megapixels: number;
}

function area(width: number, height: number, frames: number) {
  return { width, height, frames, megapixels: (width * height * frames) / 1e6 };
}

/** Skip a run of GIF data sub-blocks; returns the offset after the terminator. */
function skipGifSubBlocks(b: Uint8Array, i: number): number {
  while (i < b.length) {
    const size = b[i]!;
    i += 1;
    if (size === 0) return i;
    i += size;
  }
  return i;
}

function gifArea(b: Uint8Array): AnimatedImageArea | null {
  const width = b[6]! | (b[7]! << 8);
  const height = b[8]! | (b[9]! << 8);
  const flags = b[10]!;
  let i = 13;
  if (flags & 0x80) i += 3 * (1 << ((flags & 0x07) + 1));
  let frames = 0;
  let pixels = 0;
  while (i < b.length) {
    const block = b[i]!;
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      i = skipGifSubBlocks(b, i + 2); // extension: introducer + label
    } else if (block === 0x2c) {
      frames += 1;
      // A GIF frame only stores the rectangle that changed; count that.
      pixels += (b[i + 5]! | (b[i + 6]! << 8)) * (b[i + 7]! | (b[i + 8]! << 8));
      const local = b[i + 9]!;
      i += 10;
      if (local & 0x80) i += 3 * (1 << ((local & 0x07) + 1));
      i = skipGifSubBlocks(b, i + 1); // LZW min code size, then data
    } else {
      break; // malformed — count what we have
    }
  }
  return frames > 1
    ? { width, height, frames, megapixels: pixels / 1e6 }
    : null;
}

function webpArea(b: Uint8Array): AnimatedImageArea | null {
  const u24 = (o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
  const u32 = (o: number) => (u24(o) | (b[o + 3]! << 24)) >>> 0;
  const tag = (o: number) =>
    String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
  if (tag(12) !== "VP8X" || !(b[20]! & 0x02)) return null; // not animated
  const width = u24(24) + 1;
  const height = u24(27) + 1;
  let frames = 0;
  let i = 12;
  while (i + 8 <= b.length) {
    if (tag(i) === "ANMF") frames += 1;
    const size = u32(i + 4);
    i += 8 + size + (size & 1);
  }
  return frames > 1 ? area(width, height, frames) : null;
}

/**
 * Summed frame area for an animated GIF/WebP, or null for anything that is
 * not an animation. GIF frames are counted by their own rectangle; WebP frames
 * by the canvas, since that is what a decoder materialises per frame.
 */
export function animatedImageArea(bytes: Uint8Array): AnimatedImageArea | null {
  if (bytes.length < 30) return null;
  const head = String.fromCharCode(...bytes.subarray(0, 4));
  if (head === "GIF8") return gifArea(bytes);
  if (
    head === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return webpArea(bytes);
  }
  return null;
}

export async function readAnimatedImageArea(
  file: File,
): Promise<AnimatedImageArea | null> {
  if (file.type !== "image/gif" && file.type !== "image/webp") return null;
  try {
    return animatedImageArea(new Uint8Array(await file.arrayBuffer()));
  } catch {
    return null; // never block an upload because the header could not be read
  }
}
