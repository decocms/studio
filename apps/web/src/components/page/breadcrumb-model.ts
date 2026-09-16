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

/** Replace one ancestor range with a menu, keeping the leaf in the same list. */
export function collapseBreadcrumbs<T>(
  items: readonly T[],
  compact = false,
): BreadcrumbEntry<T>[] {
  const entries: BreadcrumbEntry<T>[] = items.map((item) => ({
    type: "item",
    item,
  }));
  if (items.length <= (compact ? 1 : 4)) return entries;

  const start = compact ? 0 : 1;
  const end = items.length - (compact ? 1 : 2);
  entries.splice(start, end - start, {
    type: "menu",
    items: items.slice(start, end),
  });
  return entries;
}
