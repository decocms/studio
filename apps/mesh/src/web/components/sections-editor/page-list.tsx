import type { LiveMeta } from "./resolve-schema";
import { listSavedSectionBlocks } from "./section-catalog";

export interface PageEntry {
  key: string;
  name: string;
  path: string;
}

export interface GlobalSectionEntry {
  key: string;
  name: string;
  resolveType: string;
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

export function globalSectionLabel(
  blockId: string,
  block: Record<string, unknown>,
): string {
  if (typeof block.name === "string") {
    const trimmed = block.name.trim();
    if (trimmed) return trimmed;
  }
  return blockId.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Saved section blocks from the decofile (same filters as the section catalog). */
export function extractGlobalSections(
  decofile: Record<string, unknown>,
  meta: LiveMeta,
): GlobalSectionEntry[] {
  return listSavedSectionBlocks(meta, decofile)
    .map((entry) => {
      const block = decofile[entry.resolveType] as Record<string, unknown>;
      const resolveType =
        typeof block.__resolveType === "string" ? block.__resolveType : "";
      return {
        key: entry.resolveType,
        name: entry.description ?? globalSectionLabel(entry.resolveType, block),
        resolveType,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
