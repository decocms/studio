const SAFE_IMAGE_PROTOCOLS = new Set(["http:", "https:", "blob:"]);

/**
 * Whether `url` may be handed to an `<img src>`.
 *
 * The value comes from a field an author types into, so it is untrusted
 * before it is anything else. `javascript:` and `data:text/html` must never
 * reach a `src`; `data:image/...` must, because that is what a pasted inline
 * image looks like.
 *
 * A value with no scheme is a relative path and stays safe — it can only ever
 * resolve against the current origin.
 */
export function isSafeImageUrl(url: string): boolean {
  const value = url.trim();
  if (!value) return false;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return true;
  if (/^data:image\//i.test(value)) return true;
  try {
    return SAFE_IMAGE_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}
