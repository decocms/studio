/**
 * Extract a URL string from values that may be plain strings OR deco's
 * multivariate flag wrapper object (`{ __resolveType, variants: [...] }`).
 * Used by ImageField and FileField so both fields agree on what counts
 * as the displayable URL when the section's schema wraps the media
 * field in a multivariate loader.
 *
 * Saving back always writes a plain string — deco resolves plain
 * strings at render time, and multi-variant editing isn't part of the
 * picker UI.
 */
export function extractUrl(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.variants)) {
    const variants = obj.variants as Array<{
      rule?: { __resolveType?: string };
      value?: unknown;
    }>;
    const always = variants.find((v) =>
      v.rule?.__resolveType?.includes("always"),
    );
    if (typeof always?.value === "string") return always.value;
    const first = variants.find((v) => typeof v.value === "string");
    if (first) return first.value as string;
  }
  if (typeof obj.src === "string") return obj.src;
  if (typeof obj.url === "string") return obj.url;
  if (typeof obj.value === "string") return obj.value;
  return "";
}
