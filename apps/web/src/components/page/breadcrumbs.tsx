import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { ChevronRight, DotsHorizontal } from "@untitledui/icons";
import { Fragment } from "react";
import { Panel } from "@/components/panel";
import { useT } from "@/i18n/use-t";

interface BreadcrumbItem {
  key: string;
  label: string;
  onClick?: () => void;
}

function Separator() {
  return (
    <ChevronRight
      aria-hidden="true"
      className="size-3 shrink-0 text-muted-foreground/60"
    />
  );
}

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
        {items.map((item) => (
          <DropdownMenuItem
            key={item.key}
            onSelect={item.onClick}
            disabled={!item.onClick}
          >
            <span className="max-w-64 truncate" title={item.label}>
              {item.label}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Feature-owned ancestors extend the route's trail before Page.Title. */
export function PageBreadcrumbs({
  items,
}: {
  items: readonly BreadcrumbItem[];
}) {
  if (items.length === 0) return null;
  const visibleItems = items.filter(
    (_, index) => index === 0 || index === items.length - 1,
  );
  const middleItems = items.slice(1, -1);
  const content = (
    <div
      data-slot="page-breadcrumbs"
      className="flex min-w-0 shrink items-center gap-2 text-sm text-muted-foreground"
    >
      <div className="flex items-center gap-2 @min-3xl/panel-header:hidden">
        <BreadcrumbMenu items={items} />
        <Separator />
      </div>
      <div className="hidden min-w-0 items-center gap-2 @min-3xl/panel-header:flex">
        {visibleItems.map((item, index) => (
          <Fragment key={item.key}>
            {index === 1 && middleItems.length > 0 && (
              <>
                <BreadcrumbMenu items={middleItems} />
                <Separator />
              </>
            )}
            {item.onClick ? (
              <button
                type="button"
                onClick={item.onClick}
                title={item.label}
                className="max-w-32 truncate rounded-lg hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {item.label}
              </button>
            ) : (
              <span className="max-w-32 truncate" title={item.label}>
                {item.label}
              </span>
            )}
            <Separator />
          </Fragment>
        ))}
      </div>
    </div>
  );
  return (
    <Panel.Topbar.Breadcrumbs.Portal fallback={content}>
      {content}
    </Panel.Topbar.Breadcrumbs.Portal>
  );
}
