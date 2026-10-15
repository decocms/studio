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
 * The first photos that answered, as bytes an image model can take.
 *
 * Sequential rather than parallel, and deliberately: the point is to get a
 * couple of usable references, not to open every URL a campaign carries at a
 * storefront that did not ask for the traffic.
 */
export async function fetchProductPhotos(
  urls: readonly string[],
  limit = MAX_REFERENCE_PHOTOS,
): Promise<ProductPhoto[]> {
  const photos: ProductPhoto[] = [];
  for (const url of urls) {
    if (photos.length >= limit) break;
    const photo = await fetchPhoto(url);
    if (photo) photos.push(photo);
  }
  return photos;
}

/** True when a declared length is present and already over the cap. */
function overDeclaredSize(res: Response): boolean {
  const declared = Number(res.headers.get("content-length"));
  return Number.isFinite(declared) && declared > MAX_PHOTO_BYTES;
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

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) {
      return null;
    }
    return { bytes, mediaType };
  } catch (err) {
    console.warn("[blog] could not fetch a product photo", err);
    return null;
  }
}
