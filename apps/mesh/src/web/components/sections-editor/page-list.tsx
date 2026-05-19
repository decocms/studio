interface PageEntry {
  key: string;
  name: string;
  path: string;
}

function parsePageName(key: string): string {
  // "pages-home-c4bcbfb771e9" -> "home"
  // "pages-Category%20Page-69217" -> "Category Page"
  let name = key;
  if (name.startsWith("pages-")) name = name.slice(6);
  // Remove trailing hash suffix (last segment after last -)
  const lastDash = name.lastIndexOf("-");
  if (lastDash > 0) {
    const suffix = name.slice(lastDash + 1);
    // Only strip if suffix looks like a hash (hex or short number)
    if (/^[a-f0-9]+$/i.test(suffix) && suffix.length >= 8) {
      name = name.slice(0, lastDash);
    }
  }
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

const PAGE_RESOLVE_TYPES = new Set([
  "website/pages/Page.tsx",
  "$live/pages/LivePage.tsx",
]);

export function extractPages(decofile: Record<string, unknown>): PageEntry[] {
  const pages: PageEntry[] = [];
  for (const [key, val] of Object.entries(decofile)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      if (
        typeof obj.__resolveType === "string" &&
        PAGE_RESOLVE_TYPES.has(obj.__resolveType) &&
        typeof obj.path === "string"
      ) {
        pages.push({
          key,
          name: typeof obj.name === "string" ? obj.name : parsePageName(key),
          path: obj.path,
        });
      }
    }
  }
  return pages;
}
