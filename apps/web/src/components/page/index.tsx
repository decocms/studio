import { Button } from "@decocms/ui/components/button.tsx";
import { Separator } from "@decocms/ui/components/separator.tsx";
import { useT } from "@/i18n/use-t";
import { Panel } from "@/components/panel";
import { cn } from "@decocms/ui/lib/utils.ts";
import { PageBreadcrumbs } from "./breadcrumbs";
import type {
  ComponentPropsWithoutRef,
  PropsWithChildren,
  ReactNode,
} from "react";

/** Route content. Panel owns the surrounding surface and persistent controls. */
function PageRoot({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      data-slot="page"
      className={cn(
        "flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden",
        className,
      )}
    />
  );
}

/** The scroll owner for document pages. Editors use Panel.Content's canvas instead. */
function PageContent({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      data-slot="page-content"
      className={cn("min-h-0 min-w-0 flex-1 overflow-auto", className)}
    />
  );
}

const CONTAINER_WIDTH = {
  reading: "max-w-[720px]",
  standard: "max-w-5xl",
  wide: "max-w-[1200px]",
  fluid: "max-w-none",
} as const;

function PageContainer({
  className,
  width = "wide",
  ...props
}: ComponentPropsWithoutRef<"div"> & { width?: keyof typeof CONTAINER_WIDTH }) {
  return (
    <div
      {...props}
      data-slot="page-container"
      data-width={width}
      className={cn(
        "mx-auto w-full px-4 py-6 md:px-8 md:py-8",
        CONTAINER_WIDTH[width],
        className,
      )}
    />
  );
}

/** Feature-owned titles move into the nearest page header, with a standalone fallback. */
function PageTitle({
  children,
  actions,
  className,
}: PropsWithChildren<{ actions?: ReactNode; className?: string }>) {
  return (
    <>
      <Panel.Topbar.Title.Portal
        fallback={
          <div
            data-slot="page-title"
            className={cn(
              "flex flex-wrap items-center justify-between gap-3",
              className,
            )}
          >
            <h1 className="min-w-0 text-xl font-medium">{children}</h1>
          </div>
        }
      >
        <h1
          data-slot="page-title"
          aria-current="page"
          title={typeof children === "string" ? children : undefined}
          className="min-w-0 truncate text-sm font-medium"
        >
          {children}
        </h1>
      </Panel.Topbar.Title.Portal>
      {actions && <PageActions>{actions}</PageActions>}
    </>
  );
}

function PageActions({
  children,
  secondary,
}: PropsWithChildren<{ secondary?: ReactNode }>) {
  const content = (
    <div data-slot="page-actions" className="flex shrink-0 items-center gap-2">
      {secondary && (
        <>
          <div className="flex items-center gap-1">{secondary}</div>
          <Separator
            orientation="vertical"
            className="mx-1 data-[orientation=vertical]:h-4"
          />
        </>
      )}
      {children}
    </div>
  );
  return (
    <Panel.Topbar.Right.Portal fallback={content}>
      {content}
    </Panel.Topbar.Right.Portal>
  );
}

/** Routes supply identity; feature pages contribute controls through the panel's slots. */
function PageHeader({
  title,
  breadcrumbs,
  leading,
  actions,
  navigation,
}: {
  title: ReactNode;
  breadcrumbs?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  navigation?: ReactNode;
}) {
  const t = useT();
  return (
    <>
      <Panel.Topbar
        className="gap-3 border-b border-border/60 px-3"
        data-testid="page-header"
      >
        <Panel.Topbar.Left className="flex-1 gap-2">
          {leading}
          <nav
            aria-label={t("page.breadcrumbs")}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            {breadcrumbs}
            <Panel.Topbar.Breadcrumbs.Target />
            <Panel.Topbar.Title className="min-w-12 flex-1">
              <Panel.Topbar.Title.Target
                fallback={
                  <h1
                    aria-current="page"
                    className="truncate text-sm font-medium"
                  >
                    {title}
                  </h1>
                }
              />
            </Panel.Topbar.Title>
          </nav>
          <Panel.Topbar.Left.Target />
        </Panel.Topbar.Left>
        <Panel.Topbar.Right className="shrink-0 gap-2">
          <div className="peer flex min-w-0 items-center gap-2 empty:hidden">
            {actions}
          </div>
          <Panel.Topbar.Right.Target className="flex items-center gap-2 before:hidden before:h-4 before:w-px before:shrink-0 before:bg-border peer-[:not(:empty)]:before:block" />
        </Panel.Topbar.Right>
      </Panel.Topbar>
      <Panel.Toolbar>
        <Panel.Toolbar.Left>
          <div data-toolbar-content="" className="min-w-0 empty:hidden">
            {navigation}
          </div>
          <Panel.Toolbar.Left.Target />
        </Panel.Toolbar.Left>
        <Panel.Toolbar.Center className="@max-xl/panel-toolbar:order-last @max-xl/panel-toolbar:basis-full [&:not(:has([data-toolbar-content]:not(:empty)))]:hidden">
          <Panel.Toolbar.Center.Target />
        </Panel.Toolbar.Center>
        <Panel.Toolbar.Right>
          <Panel.Toolbar.Right.Target />
        </Panel.Toolbar.Right>
      </Panel.Toolbar>
    </>
  );
}

/** Navigation between views keeps labels visible and scrolls when space is limited. */
function PageTabs({ className, ...props }: ComponentPropsWithoutRef<"nav">) {
  const t = useT();
  return (
    <nav
      aria-label={t("page.views")}
      {...props}
      data-slot="page-tabs"
      className={cn(
        "flex min-w-0 items-center gap-1 overflow-x-auto no-scrollbar",
        className,
      )}
    />
  );
}

function PageTab({
  active,
  asChild = false,
  className,
  ...props
}: ComponentPropsWithoutRef<"button"> & {
  active: boolean;
  asChild?: boolean;
}) {
  return (
    <Button
      asChild={asChild}
      variant="ghost"
      size="sm"
      {...props}
      type={asChild ? undefined : "button"}
      aria-current={asChild && active ? "page" : undefined}
      aria-pressed={asChild ? undefined : active}
      data-slot="page-tab"
      className={cn(
        "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        active
          ? "border-border bg-accent text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        className,
      )}
    />
  );
}

export const Page = Object.assign(PageRoot, {
  Header: PageHeader,
  Tabs: PageTabs,
  Tab: PageTab,
  Actions: PageActions,
  Content: PageContent,
  Container: PageContainer,
  Title: PageTitle,
  Breadcrumbs: PageBreadcrumbs,
});
