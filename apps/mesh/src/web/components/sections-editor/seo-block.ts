const PAGE_RESOLVE_TYPES = new Set([
  "website/pages/Page.tsx",
  "$live/pages/LivePage.tsx",
]);

/** Default deco SEO section type — schema fallback for inlined SEO props. */
const DEFAULT_SEO_RESOLVE_TYPE = "website/sections/Seo/SeoV2.tsx";

/** Props that mark an object as SEO config even without a `__resolveType`. */
const SEO_FIELD_HINTS = [
  "title",
  "titleTemplate",
  "description",
  "descriptionTemplate",
  "image",
  "favicon",
  "type",
  "noIndexing",
];

export interface SiteSeoEntry {
  /** Decofile key of the block that owns the SEO data. */
  blockKey: string;
  /**
   * "block": the decofile entry *is* the SEO block — saving replaces the entry.
   * "nested": the SEO lives under `entry.seo` on a config block (e.g. the
   * website/site app) — saving writes `{ ...blockData, seo }`.
   */
  kind: "block" | "nested";
  seoData: Record<string, unknown>;
  blockData: Record<string, unknown>;
  /** resolveType to resolve the form schema with (SEO props may be inlined). */
  seoResolveType: string;
}

/** Matches SEO section resolveTypes, e.g. "website/sections/Seo/SeoV2.tsx". */
function isSeoResolveType(rt: unknown): rt is string {
  return (
    typeof rt === "string" &&
    (/\/Seo(V\d+)?\.tsx$/i.test(rt) || rt.includes("/sections/Seo"))
  );
}

function looksLikeSeo(obj: Record<string, unknown>): boolean {
  if (isSeoResolveType(obj.__resolveType)) return true;
  return SEO_FIELD_HINTS.some((k) => k in obj);
}

/**
 * The SEO section resolveType used somewhere in this decofile (pages reference
 * it via `seo.__resolveType`), so the site default's inlined props get the
 * right form schema. Falls back to the deco default.
 */
function inferSeoResolveType(decofile: Record<string, unknown>): string {
  for (const val of Object.values(decofile)) {
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const obj = val as Record<string, unknown>;
    if (isSeoResolveType(obj.__resolveType)) return obj.__resolveType;
    const seo = obj.seo as Record<string, unknown> | undefined;
    if (seo && typeof seo === "object" && isSeoResolveType(seo.__resolveType)) {
      return seo.__resolveType;
    }
  }
  return DEFAULT_SEO_RESOLVE_TYPE;
}

/**
 * Finds the site-level (default) SEO that pages inherit from. Deco sites store
 * this in one of a few shapes, checked in order:
 *
 *   1. SEO nested under a non-page config block (e.g. the `site` app config's
 *      `seo` prop) — often inlined props with no `__resolveType`. This is the
 *      true "applied to every page unless overridden" default.
 *   2. A standalone SEO block — a decofile entry whose own `__resolveType` is
 *      an SEO type (the block *is* the SEO).
 */
export function findSiteSeoEntry(
  decofile: Record<string, unknown>,
): SiteSeoEntry | null {
  // 1) SEO nested on a non-page config block.
  for (const [key, val] of Object.entries(decofile)) {
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const obj = val as Record<string, unknown>;
    if (PAGE_RESOLVE_TYPES.has(obj.__resolveType as string)) continue;
    const seo = obj.seo;
    if (seo && typeof seo === "object" && !Array.isArray(seo)) {
      const seoObj = seo as Record<string, unknown>;
      if (looksLikeSeo(seoObj)) {
        return {
          blockKey: key,
          kind: "nested",
          seoData: seoObj,
          blockData: obj,
          seoResolveType: isSeoResolveType(seoObj.__resolveType)
            ? seoObj.__resolveType
            : inferSeoResolveType(decofile),
        };
      }
    }
  }

  // 2) Standalone SEO block.
  for (const [key, val] of Object.entries(decofile)) {
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const obj = val as Record<string, unknown>;
    if (isSeoResolveType(obj.__resolveType)) {
      return {
        blockKey: key,
        kind: "block",
        seoData: obj,
        blockData: obj,
        seoResolveType: obj.__resolveType,
      };
    }
  }
  return null;
}

/** Builds the decofile block payload to persist an edited site-SEO value. */
export function buildSiteSeoBlockData(
  entry: SiteSeoEntry,
  value: Record<string, unknown>,
): Record<string, unknown> {
  return entry.kind === "block" ? value : { ...entry.blockData, seo: value };
}
