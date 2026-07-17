/**
 * Helpers for reading/writing deco-CDN transform params on a media URL's query
 * string — `quality` (images + video) and `muted` (video). Kept URL-string
 * based (not object state) so the value the form persists is always the plain
 * URL other tools already understand. Every writer round-trips through URL when
 * possible and falls back to raw string editing for non-absolute values.
 */

export type Quality = "low" | "medium" | "high" | "original";

export const QUALITY_OPTIONS: Quality[] = ["low", "medium", "high", "original"];

export function isQuality(v: string | null): v is Quality {
  return v === "low" || v === "medium" || v === "high" || v === "original";
}

/** Read the `quality` query param off a media URL, if present and valid. */
export function getQualityFromUrl(
  url: string | undefined,
): Quality | undefined {
  if (!url) return undefined;
  try {
    const q = new URL(url).searchParams.get("quality");
    return isQuality(q) ? q : undefined;
  } catch {
    // Not an absolute URL — fall back to a raw query-string match.
    const match = url.match(/[?&]quality=(low|medium|high|original)\b/);
    return match && isQuality(match[1]!) ? (match[1] as Quality) : undefined;
  }
}

/** Write (or clear, when `undefined`) the `quality` query param on a URL. */
export function setQualityOnUrl(
  url: string,
  quality: Quality | undefined,
): string {
  try {
    const u = new URL(url);
    if (quality) u.searchParams.set("quality", quality);
    else u.searchParams.delete("quality");
    return u.toString();
  } catch {
    // Non-URL string: strip any existing quality param, then re-append.
    const cleaned = url
      .replace(/([?&])quality=[^&]*(&|$)/, "$1")
      .replace(/[?&]$/, "");
    if (!quality) return cleaned;
    const sep = cleaned.includes("?") ? "&" : "?";
    return `${cleaned}${sep}quality=${quality}`;
  }
}

/**
 * Whether the URL is muted. Muted is the CDN default, so only `muted=false`
 * means "play with sound" — no param (or any other value) reads as muted. We
 * therefore only ever write `muted=false` explicitly and delete otherwise.
 */
export function getMutedFromUrl(url: string | undefined): boolean {
  if (!url) return true;
  try {
    return new URL(url).searchParams.get("muted") !== "false";
  } catch {
    return !/[?&]muted=false\b/.test(url);
  }
}

/** Write `muted=false` when unmuted; clear the param when muted (default). */
export function setMutedOnUrl(url: string, muted: boolean): string {
  try {
    const u = new URL(url);
    if (muted) u.searchParams.delete("muted");
    else u.searchParams.set("muted", "false");
    return u.toString();
  } catch {
    const cleaned = url
      .replace(/([?&])muted=[^&]*(&|$)/, "$1")
      .replace(/[?&]$/, "");
    if (muted) return cleaned;
    const sep = cleaned.includes("?") ? "&" : "?";
    return `${cleaned}${sep}muted=false`;
  }
}
