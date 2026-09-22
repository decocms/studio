import type { LinkOptions } from "@tanstack/react-router";
import type { ReactNode } from "react";

export interface BreadcrumbItem {
  key: string;
  label: ReactNode;
  link?: LinkOptions;
  onSelect?: () => void;
}

/** Update an existing segment and insert its component-owned descendants. */
export interface BreadcrumbExtension {
  after: string;
  parent?: Partial<Omit<BreadcrumbItem, "key">>;
  items?: readonly BreadcrumbItem[];
}

/** Anchors make composition independent of the order components mount in. */
export function resolveBreadcrumbs(
  items: readonly BreadcrumbItem[],
  extensions: ReadonlyMap<string, BreadcrumbExtension>,
): BreadcrumbItem[] {
  const seen = new Set<string>();
  const visit = (item: BreadcrumbItem): BreadcrumbItem[] => {
    if (seen.has(item.key)) {
      throw new Error(`Duplicate breadcrumb key: ${item.key}`);
    }
    seen.add(item.key);
    const extension = extensions.get(item.key);
    return [
      { ...item, ...extension?.parent },
      ...(extension?.items?.flatMap(visit) ?? []),
    ];
  };
  return items.flatMap(visit);
}

type BreadcrumbEntry<T> =
  | { type: "item"; item: T }
  | { type: "menu"; items: readonly T[] };

/**
 * How deep a trail gets before it is worth hiding any of it. Reading the whole
 * path beats saving a little width, so collapsing starts one past the limit.
 * The limit belongs to the page layout, so the caller passes it in — it says
 * nothing about `collapseBreadcrumbs`' own `compact` argument, which is width.
 */
export const CLASSIC_MAX_UNCOLLAPSED_ITEMS = 4;

/** The consistent layout's header fits one more ancestor before collapsing. */
export const COMPACT_LAYOUT_MAX_UNCOLLAPSED_ITEMS = 5;

/** Replace one ancestor range with a menu, keeping the leaf in the same list. */
export function collapseBreadcrumbs<T>(
  items: readonly T[],
  compact = false,
  maxUncollapsedItems: number = CLASSIC_MAX_UNCOLLAPSED_ITEMS,
): BreadcrumbEntry<T>[] {
  const entries: BreadcrumbEntry<T>[] = items.map((item) => ({
    type: "item",
    item,
  }));
  // `compact` is the container being too narrow to show a path at all, not the
  // layout preference — there, only the leaf survives whatever the depth.
  if (items.length <= (compact ? 1 : maxUncollapsedItems)) return entries;

  const start = compact ? 0 : 1;
  const end = items.length - (compact ? 1 : 2);
  entries.splice(start, end - start, {
    type: "menu",
    items: items.slice(start, end),
  });
  return entries;
}
