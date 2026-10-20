import type { LiveMeta } from "./resolve-schema";

/** v7 (and Fresh/Deno) page block types, known without a schema. */
const LEGACY_PAGE_RESOLVE_TYPES = new Set([
  "website/pages/Page.tsx",
  "$live/pages/LivePage.tsx",
]);

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
  if (LEGACY_PAGE_RESOLVE_TYPES.has(resolveType)) return true;
  return Object.hasOwn(meta?.manifest?.blocks?.pages ?? {}, resolveType);
}
