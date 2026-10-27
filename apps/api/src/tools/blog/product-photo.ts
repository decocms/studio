import {
  createNoRedirectFetch,
  guardAgainstPrivateUrl,
  withTimeout,
} from "../../mcp-clients/url-security";

/**
 * A product's own photograph, fetched so a cover can be generated from it.
 *
 * Without one the image model invents a product, and a post about a backpack
 * illustrated with a backpack nobody sells is worse than a post with no image:
 * it is a picture of a thing the brand cannot ship.
 *
 * These URLs are the least trusted input in the feature. They reach a campaign
 * by way of a model reading raw output from third-party systems, so "fetch what
 * the record says" is a server-side request to an address a stranger chose —
 * the shape of every SSRF. `guardAgainstPrivateUrl` is the repo's answer and is
 * reused whole, redirect refusal included: vetting an address means nothing if
 * the response can 302 somewhere else.
 *
 * Every failure is a skipped photo, never a failed post. The cover falls back
 * to the written brief, which is what it was before product photos existed.
 */

/** One photo. Generous for a CDN original, far below what would be abused. */
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** The whole fetch, including connect and DNS. */
const PHOTO_TIMEOUT_MS = 10_000;

/**
 * Photos handed to one generation.
 *
 * A reference set, not a gallery: past a handful the model averages them into
 * something that resembles none of the products, and each one is weight in a
 * request that already has a timeout.
 */
export const MAX_REFERENCE_PHOTOS = 3;

/** What an image model will accept, and what a storefront actually serves. */
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export interface ProductPhoto {
  bytes: Uint8Array;
  mediaType: string;
}

const noRedirectFetch = createNoRedirectFetch();

/**
 * The photos that answered first, as bytes an image model can take.
 *
 * Only the first few URLs are tried, and together rather than in turn. One at a
 * time, a dozen slow or dead addresses spend two minutes before the first image
 * is even requested — which is the whole budget, on fetching references for a
 * picture that then never gets drawn. Asking for a few at once bounds the wait
 * at one timeout instead of a dozen, and a storefront serving its own product
 * photographs is not troubled by three parallel reads.
 */
export async function fetchProductPhotos(
  urls: readonly string[],
  limit = MAX_REFERENCE_PHOTOS,
): Promise<ProductPhoto[]> {
  const tried = await Promise.all(urls.slice(0, limit).map(fetchPhoto));
  return tried.filter((photo): photo is ProductPhoto => photo !== null);
}

/** True when a declared length is present and already over the cap. */
function overDeclaredSize(res: Response): boolean {
  const declared = Number(res.headers.get("content-length"));
  return Number.isFinite(declared) && declared > MAX_PHOTO_BYTES;
}

/**
 * The body, stopping the moment it passes `maxBytes` rather than after.
 *
 * `content-length` is a header the remote server writes — nothing stops it
 * from omitting it or lying low while streaming without end. Without this, a
 * response with no declared length (or an understated one) is buffered whole
 * by `arrayBuffer()` before the size is ever checked, which is the cap doing
 * nothing for the shape of request it exists for.
 */
export async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.byteLength > maxBytes ? null : bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function fetchPhoto(url: string): Promise<ProductPhoto | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  try {
    const blocked = await guardAgainstPrivateUrl(url);
    if (blocked) {
      console.warn(`[blog] refused a product photo: ${blocked}`);
      return null;
    }

    const res = await withTimeout(
      noRedirectFetch(url, { headers: { accept: "image/*" } }),
      PHOTO_TIMEOUT_MS,
      "product photo timed out",
    );
    if (!res.ok) return null;

    const mediaType = (res.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (!ALLOWED_TYPES.has(mediaType)) return null;
    if (overDeclaredSize(res)) return null;

    const bytes = await readCapped(res, MAX_PHOTO_BYTES);
    if (!bytes || bytes.byteLength === 0) return null;
    return { bytes, mediaType };
  } catch (err) {
    console.warn("[blog] could not fetch a product photo", err);
    return null;
  }
}
