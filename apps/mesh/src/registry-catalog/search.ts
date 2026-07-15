/**
 * Pure search/filter predicates over catalog items.
 *
 * Mirrors the semantics of the old `buildRegistrySearchWhere`
 * (`web/hooks/use-merged-store-discovery.ts`): the free-text term matches as a
 * case-insensitive substring across title / description / server.name /
 * server.title (OR). Tag and category filters use AND semantics (the item must
 * carry every requested value), matching the old registry tools' filters.
 *
 * No I/O — unit-tested directly.
 */

import type { CatalogItem, CatalogListQuery } from "./types";

function meshTags(item: CatalogItem): string[] {
  return item._meta?.["mcp.mesh"]?.tags ?? [];
}

function meshCategories(item: CatalogItem): string[] {
  return item._meta?.["mcp.mesh"]?.categories ?? [];
}

/** Case-insensitive substring match across the searchable text fields. */
export function matchesSearch(item: CatalogItem, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  const haystacks = [
    item.title,
    item.server?.description,
    item.server?.name,
    item.server?.title,
  ];
  return haystacks.some((h) => (h?.toLowerCase() ?? "").includes(needle));
}

function hasAll(have: string[], want: string[]): boolean {
  if (want.length === 0) return true;
  const set = new Set(have);
  return want.every((v) => set.has(v));
}

/** Apply free-text + tag + category filters (all ANDed together). */
export function filterItems(
  items: CatalogItem[],
  query: Pick<CatalogListQuery, "search" | "tags" | "categories" | "name">,
): CatalogItem[] {
  const { search, tags, categories, name } = query;
  return items.filter((item) => {
    if (name && item.server?.name !== name) return false;
    if (search && !matchesSearch(item, search)) return false;
    if (tags?.length && !hasAll(meshTags(item), tags)) return false;
    if (categories?.length && !hasAll(meshCategories(item), categories)) {
      return false;
    }
    return true;
  });
}
