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

/** Short trails stay intact; longer ones keep the root, parent, and leaf. */
export function collapseBreadcrumbs<T>(items: readonly T[], compact = false) {
  if (compact && items.length > 1) {
    return { start: [], collapsed: items.slice(0, -1), end: items.slice(-1) };
  }
  return items.length > 4
    ? {
        start: items.slice(0, 1),
        collapsed: items.slice(1, -2),
        end: items.slice(-2),
      }
    : { start: [], collapsed: [], end: items };
}
