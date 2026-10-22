import { isV8Schema } from "@decocms/shared/blocks-major";
import type { LiveMeta } from "./resolve-schema";

/**
 * v7 (and Fresh/Deno) page block types, known without a schema. The first is
 * the current runtimes' page block, the default without a manifest.
 */
export const LEGACY_PAGE_RESOLVE_TYPES = [
  "website/pages/Page.tsx",
  "$live/pages/LivePage.tsx",
] as const;

const LEGACY_PAGE_RESOLVE_TYPE_SET = new Set<string>(LEGACY_PAGE_RESOLVE_TYPES);

/** Whether a page type is one of the v7 (Fresh/Deno) page file names. */
export function isLegacyPageResolveType(resolveType: string): boolean {
  return LEGACY_PAGE_RESOLVE_TYPE_SET.has(resolveType);
}

/**
 * Whether a block type is a page: a v7 page name, or any type the site's
 * schema lists under `pages` (next-major's built-in `page` and a site's own
 * routable types, such as a blog's `post`). Without a schema a short name
 * like `page` may be a saved block's key, so only the v7 names count.
 */
export function isPageResolveType(
  resolveType: string,
  meta?: Pick<LiveMeta, "manifest"> | null,
): boolean {
  if (isLegacyPageResolveType(resolveType)) return true;
  return Object.hasOwn(meta?.manifest?.blocks?.pages ?? {}, resolveType);
}

/**
 * {@link isPageResolveType} where v7 only knew the two v7 page names (the
 * site SEO lookup, the blog's page templates): a Blocks v8 site's schema
 * (`isV8Schema`) adds its own page types; any other site keeps the v7 names
 * alone, as before.
 */
export function isPageResolveTypeOnBlocksSite(
  resolveType: string,
  meta?: Pick<LiveMeta, "manifest"> | null,
): boolean {
  return isPageResolveType(resolveType, isV8Schema(meta) ? meta : undefined);
}
