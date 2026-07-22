/**
 * Helpers for reading/writing deco-CDN transform params on a media URL's query
 * string — `quality` (images + video) and `muted` (video). Kept URL-string
 * based (not object state) so the value the form persists is always the plain
 * URL other tools already understand.
 *
 * Writes edit the raw string rather than round-tripping through `URL`: that
 * preserves a `#fragment`, keeps every untouched param byte-for-byte (no
 * re-encoding of e.g. `caption=a b` or a signed-URL param), and clears *all*
 * occurrences of a repeated param without leaving a dangling `?`/`&`.
 */

export type Quality = "low" | "medium" | "high" | "original";

export const QUALITY_OPTIONS: Quality[] = ["low", "medium", "high", "original"];

export function isQuality(v: string | null): v is Quality {
  return v === "low" || v === "medium" || v === "high" || v === "original";
}

/** Read the first value of `key` from a URL's query string, if present. */
function getParam(url: string, key: string): string | null {
  try {
    return new URL(url).searchParams.get(key);
  } catch {
    // Not an absolute URL — scan the raw query string ourselves.
    const query = rawQuery(url);
    for (const pair of query) {
      const eq = pair.indexOf("=");
      const k = eq >= 0 ? pair.slice(0, eq) : pair;
      if (k === key) return eq >= 0 ? pair.slice(eq + 1) : "";
    }
    return null;
  }
}

/**
 * Write (or clear, when `value` is undefined) `key` on a URL, editing the raw
 * string so the fragment and every other param are preserved exactly.
 */
function setParam(url: string, key: string, value: string | undefined): string {
  const hashIdx = url.indexOf("#");
  const hash = hashIdx >= 0 ? url.slice(hashIdx) : "";
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const qIdx = base.indexOf("?");
  const path = qIdx >= 0 ? base.slice(0, qIdx) : base;

  const kept = (qIdx >= 0 ? base.slice(qIdx + 1).split("&") : [])
    .filter(Boolean)
    .filter((pair) => {
      const eq = pair.indexOf("=");
      return (eq >= 0 ? pair.slice(0, eq) : pair) !== key;
    });
  if (value !== undefined) kept.push(`${key}=${value}`);

  return `${path}${kept.length ? `?${kept.join("&")}` : ""}${hash}`;
}

/** Split the raw (non-absolute-URL) query string into `key=value` pairs. */
function rawQuery(url: string): string[] {
  const hashIdx = url.indexOf("#");
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const qIdx = base.indexOf("?");
  if (qIdx < 0) return [];
  return base
    .slice(qIdx + 1)
    .split("&")
    .filter(Boolean);
}

/** Read the `quality` query param off a media URL, if present and valid. */
export function getQualityFromUrl(
  url: string | undefined,
): Quality | undefined {
  if (!url) return undefined;
  const q = getParam(url, "quality");
  return isQuality(q) ? q : undefined;
}

/** Write (or clear, when `undefined`) the `quality` query param on a URL. */
export function setQualityOnUrl(
  url: string,
  quality: Quality | undefined,
): string {
  return setParam(url, "quality", quality);
}

/**
 * Whether the URL is muted. Muted is the CDN default, so only `muted=false`
 * means "play with sound" — no param (or any other value) reads as muted. We
 * therefore only ever write `muted=false` explicitly and delete otherwise.
 */
export function getMutedFromUrl(url: string | undefined): boolean {
  if (!url) return true;
  return getParam(url, "muted") !== "false";
}

/** Write `muted=false` when unmuted; clear the param when muted (default). */
export function setMutedOnUrl(url: string, muted: boolean): string {
  return setParam(url, "muted", muted ? undefined : "false");
}
