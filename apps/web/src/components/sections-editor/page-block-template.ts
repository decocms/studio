import type { LiveMeta } from "./resolve-schema";
import {
  findNewPageResolveType,
  isLegacyPageResolveType,
} from "./section-catalog";
import { defaultPageSeoResolveType } from "./seo-schema";

/**
 * Block types a new page gets on a v7 site (and when the site's schema isn't
 * loaded): the website app's page with its general SEO section.
 */
export const DEFAULT_PAGE_BLOCK = {
  resolveType: "website/pages/Page.tsx",
  seoResolveType: "website/sections/Seo/SeoV2.tsx",
} as const;

export function generatePageBlockKey(name: string): string {
  return `pages-${encodeURIComponent(name)}-${crypto.randomUUID()}`;
}

/**
 * A new, empty page, typed from the site's own schema: the page type the site
 * declares (`page` on next-major sites) and, for `seo`, the SEO type its page
 * schema's `seo` field offers — no `seo` at all when it offers none. A v7 site
 * (or no schema yet) gets the v7 page and SEO section, as before.
 */
export function createEmptyPageBlock(
  name: string,
  path: string,
  meta?: LiveMeta | null,
): Record<string, unknown> {
  const pageResolveType = findNewPageResolveType(meta ?? undefined);
  if (!meta || isLegacyPageResolveType(pageResolveType)) {
    return {
      name,
      path,
      sections: [] as unknown[],
      seo: { __resolveType: DEFAULT_PAGE_BLOCK.seoResolveType },
      __resolveType: DEFAULT_PAGE_BLOCK.resolveType,
    };
  }
  const seoResolveType = defaultPageSeoResolveType(meta);
  return {
    name,
    path,
    sections: [] as unknown[],
    ...(seoResolveType ? { seo: { __resolveType: seoResolveType } } : {}),
    __resolveType: pageResolveType,
  };
}
