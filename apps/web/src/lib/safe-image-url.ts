/**
 * Only allow remote https images (blocks `javascript:`, `data:`, `vbscript:`).
 *
 * The scheme check IS the sanitizer: an `<img src>` is an HTML sink, and a
 * string the user typed reaches it. Returning the parsed `href` rather than the
 * input is deliberate — it hands on a URL that has been through the parser, not
 * the raw text, so no caller can accidentally pass the unchecked value along.
 */
export function safeImageUrl(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
