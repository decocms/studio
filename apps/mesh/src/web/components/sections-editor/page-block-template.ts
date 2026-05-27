/** Default block types for new pages created from the preview page picker. */
export const DEFAULT_PAGE_BLOCK = {
  resolveType: "website/pages/Page.tsx",
  seoResolveType: "website/sections/Seo/SeoV2.tsx",
} as const;

export function generatePageBlockKey(name: string): string {
  return `pages-${encodeURIComponent(name)}-${Math.floor(Math.random() * 1e6)}`;
}

export function createEmptyPageBlock(name: string, path: string) {
  return {
    name,
    path,
    sections: [] as unknown[],
    seo: { __resolveType: DEFAULT_PAGE_BLOCK.seoResolveType },
    __resolveType: DEFAULT_PAGE_BLOCK.resolveType,
  };
}
