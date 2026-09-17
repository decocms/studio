import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { createLink } from "@tanstack/react-router";
import { ChevronRight, DotsHorizontal } from "@untitledui/icons";
import { useSyncExternalStore, type ComponentPropsWithRef } from "react";
import { useT } from "@/i18n/use-t";
import { useElementWidth } from "@/hooks/use-element-width";
import { useCompactPageLayout } from "@/hooks/use-preferences";
import {
  BreadcrumbContribution,
  BreadcrumbProvider,
  useBreadcrumbStore,
} from "./breadcrumb-context";
import {
  CLASSIC_MAX_UNCOLLAPSED_ITEMS,
  COMPACT_LAYOUT_MAX_UNCOLLAPSED_ITEMS,
  collapseBreadcrumbs,
  resolveBreadcrumbs,
  type BreadcrumbExtension,
  type BreadcrumbItem,
} from "./breadcrumb-model";

// The trail's final position, rather than a router prefix match, defines current.
const BreadcrumbLink = createLink(function BreadcrumbAnchor(
  props: ComponentPropsWithRef<"a">,
) {
  return <a {...props} aria-current={undefined} />;
});

function BreadcrumbMenu({ items }: { items: readonly BreadcrumbItem[] }) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0"
          aria-label={t("page.breadcrumbMenu")}
        >
          <DotsHorizontal aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {items.map((item) => {
          const label = (
            <span
              className="max-w-64 truncate"
              title={typeof item.label === "string" ? item.label : undefined}
            >
              {item.label}
            </span>
          );
          return (
            <DropdownMenuItem
              key={item.key}
              asChild={!!item.link && !item.onSelect}
              onSelect={item.onSelect}
              disabled={!item.onSelect && !item.link}
            >
              {item.link && !item.onSelect ? (
                <BreadcrumbLink {...item.link}>{label}</BreadcrumbLink>
              ) : (
                label
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BreadcrumbSegment({
  item,
  current,
}: {
  item: BreadcrumbItem;
  current: boolean;
}) {
  const title = typeof item.label === "string" ? item.label : undefined;
  if (current) {
    return (
      <h1
        data-slot="page-title"
        aria-current="page"
        title={title}
        className="truncate text-sm font-medium text-foreground"
      >
        {item.label}
      </h1>
    );
  }
  const className =
    "block max-w-40 truncate rounded-lg hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  if (item.onSelect) {
    return (
      <button
        type="button"
        onClick={item.onSelect}
        title={title}
        className={className}
      >
        {item.label}
      </button>
    );
  }
  if (item.link) {
    return (
      <BreadcrumbLink {...item.link} title={title} className={className}>
        {item.label}
      </BreadcrumbLink>
    );
  }
  return (
    <span title={title} className="block max-w-40 truncate">
      {item.label}
    </span>
  );
}

function BreadcrumbTrail({ items }: { items: readonly BreadcrumbItem[] }) {
  const t = useT();
  // Named for the preference, because the second argument below is the other
  // kind of compact: a container too narrow for a path, whatever the layout.
  const compactLayout = useCompactPageLayout();
  const [width, ref] = useElementWidth();
  const entries = collapseBreadcrumbs(
    items,
    width >= 0 && width < 320,
    compactLayout
      ? COMPACT_LAYOUT_MAX_UNCOLLAPSED_ITEMS
      : CLASSIC_MAX_UNCOLLAPSED_ITEMS,
  );
  return (
    <nav
      ref={ref}
      aria-label={t("page.breadcrumbs")}
      className="min-w-0 flex-1"
    >
      <ol
        data-slot="page-breadcrumbs"
        className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
      >
        {entries.map((entry, index) => (
          <li
            key={entry.type === "item" ? `item:${entry.item.key}` : "menu"}
            className={cn(
              "flex min-w-0 items-center gap-2",
              index > 0 && "min-w-5",
              entry.type === "item"
                ? "last:min-w-16 last:flex-[1_1_auto]"
                : "shrink-0",
            )}
          >
            {index > 0 && (
              <ChevronRight
                aria-hidden="true"
                className="size-3 shrink-0 text-muted-foreground/60"
              />
            )}
            {entry.type === "item" ? (
              <BreadcrumbSegment
                item={entry.item}
                current={index === entries.length - 1}
              />
            ) : (
              <BreadcrumbMenu items={entry.items} />
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** One renderer owns the complete path, including the only current segment. */
export function PageHeaderBreadcrumbs({
  items,
}: {
  items: readonly BreadcrumbItem[];
}) {
  const store = useBreadcrumbStore();
  if (!store) throw new Error("Page.Header requires Page.Breadcrumbs.Provider");
  const extensions = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return <BreadcrumbTrail items={resolveBreadcrumbs(items, extensions)} />;
}

function PageBreadcrumbsRoot(extension: BreadcrumbExtension) {
  const store = useBreadcrumbStore();
  return store ? (
    <BreadcrumbContribution {...extension} />
  ) : (
    <BreadcrumbTrail items={extension.items ?? []} />
  );
}

export const PageBreadcrumbs = Object.assign(PageBreadcrumbsRoot, {
  Provider: BreadcrumbProvider,
});
