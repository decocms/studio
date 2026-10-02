const SAFE_IMAGE_PROTOCOLS = new Set(["http:", "https:", "blob:"]);

/** C0 controls plus DEL — what a browser deletes from a URL before parsing. */
// oxlint-disable-next-line no-control-regex -- matching them is the point
const STRIPPED_BY_THE_BROWSER = /[\u0000-\u001F\u007F]/g;

/**
 * Browsers delete tab, newline and carriage return anywhere inside a URL
 * before parsing it, so `java\nscript:` loads as `javascript:`. The check has
 * to see the same string the browser will, and the caller has to render the
 * stripped value — validating one string and emitting another is the bypass.
 */
function normalize(url: string): string {
  return url.replace(STRIPPED_BY_THE_BROWSER, "").trim();
}

/** A scheme is present when the value starts `word:`, per RFC 3986. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Whether `url` may be handed to an `<img src>`.
 *
 * The value comes from a field an author types into, so it is untrusted
 * before it is anything else. `javascript:` and `data:text/html` must never
 * reach a `src`; `data:image/...` must, because that is what a pasted inline
 * image looks like. A value with no scheme is a relative path and can only
 * ever resolve against the current origin.
 */
export function isSafeImageUrl(url: string): boolean {
  return safeImageSrc(url) !== "";
}

/**
 * `url` reduced to something an `<img src>` may receive, or `""` when there
 * is no safe reading of it. Returning the sanitized value rather than a
 * boolean keeps the check ON the dataflow path, so no caller can validate one
 * string and render a different one.
 */
export function safeImageSrc(url: string): string {
  const value = normalize(url);
  if (!value) return "";
  if (!HAS_SCHEME.test(value)) {
    try {
      return encodeURI(value);
    } catch {
      // A lone surrogate — unrenderable either way.
      return "";
    }
  }
  if (/^data:image\//i.test(value)) return value;
  try {
    const parsed = new URL(value);
    return SAFE_IMAGE_PROTOCOLS.has(parsed.protocol) ? parsed.href : "";
  } catch {
    return "";
  }
}
