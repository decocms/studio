import { readVariantValue } from "../variant-shape";

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
    // v8's `multivariate` keeps each value in a `lazy` block.
    const always = variants.find((v) =>
      v.rule?.__resolveType?.includes("always"),
    );
    const alwaysValue = readVariantValue(always);
    if (typeof alwaysValue === "string") return alwaysValue;
    const first = variants
      .map((v) => readVariantValue(v))
      .find((v) => typeof v === "string");
    if (typeof first === "string") return first;
  }
  if (typeof obj.src === "string") return obj.src;
  if (typeof obj.url === "string") return obj.url;
  if (typeof obj.value === "string") return obj.value;
  return "";
}
