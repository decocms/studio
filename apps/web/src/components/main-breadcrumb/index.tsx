import type {
  ComponentPropsWithRef,
  ForwardedRef,
  MouseEventHandler,
  ReactNode,
} from "react";
import { useRef } from "react";
import {
  type LinkProps,
  useLinkProps,
  useRouterState,
} from "@tanstack/react-router";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@decocms/ui/components/breadcrumb.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t";
import { DotsHorizontal } from "@untitledui/icons";
import {
  isMainBreadcrumbScopeCurrent,
  resolveMainBreadcrumbAncestorPresentation,
} from "./trail";
import { Main } from "@/components/main";

interface MainBreadcrumbItemBase {
  /** Stable identity; labels are localized and can change. */
  id: string;
  label: string;
  /** Optional compact visual; its label still supplies the accessible name. */
  icon?: ReactNode;
}

type MainBreadcrumbLinkProps = Omit<
  LinkProps,
  "children" | "className" | "onClick"
>;

interface MainBreadcrumbLinkNavigation {
  /** A known destination stays a real link, preserving open-in-new-tab. */
  link: MainBreadcrumbLinkProps;
  /** Optional analytics or local cleanup performed alongside navigation. */
  onSelect?: () => void;
}

interface MainBreadcrumbCallbackNavigation {
  /** State-owned transitions, such as leaving an edited task, are buttons. */
  onSelect: () => void;
  link?: never;
}

export type MainBreadcrumbNavigableItem = MainBreadcrumbItemBase &
  (MainBreadcrumbLinkNavigation | MainBreadcrumbCallbackNavigation);

type MainBreadcrumbLinkItem = MainBreadcrumbItemBase &
  MainBreadcrumbLinkNavigation;

function isMainBreadcrumbLinkItem(
  item: MainBreadcrumbNavigableItem,
): item is MainBreadcrumbLinkItem {
  return item.link !== undefined;
}

export type MainBreadcrumbCurrentItem = MainBreadcrumbItemBase;

export interface MainBreadcrumbProps {
  /** The organization or project that anchors this route. */
  scope: MainBreadcrumbNavigableItem;
  /**
   * Semantic parents ordered outermost to innermost, with stable ids. The
   * nearest is shown inline and earlier ancestors remain available from
   * overflow.
   */
  ancestors?: readonly MainBreadcrumbNavigableItem[];
  /** The adjacent page title and the route's only top-level heading. */
  current: MainBreadcrumbCurrentItem;
  className?: string;
  /** Override only when embedding this in a differently named navigation. */
  ariaLabel?: string;
  /**
   * Workspace routes already expose the current destination in their compact
   * view switcher. They can keep the one semantic heading visually hidden
   * until the breadcrumb trail appears at the desktop breakpoint.
   */
  compactTitle?: "visible" | "visually-hidden";
}

/**
 * TanStack's link behavior on a real anchor. `aria-current` is removed because
 * this landmark contains parents only; the adjacent `h1` owns the current
 * route. The router otherwise marks an active Home/project parent as current.
 */
function BreadcrumbRouterLink({
  item,
  children,
  className,
  onClick,
  ref,
  ...props
}: Omit<ComponentPropsWithRef<"a">, "href" | "ref"> & {
  item: MainBreadcrumbLinkItem;
  ref?: ForwardedRef<Element>;
}) {
  const handleClick: MouseEventHandler<HTMLAnchorElement> = (event) => {
    onClick?.(event);
    if (!event.defaultPrevented) item.onSelect?.();
  };
  const linkProps = useLinkProps(
    {
      ...props,
      ...item.link,
      className,
      onClick: handleClick,
    },
    ref,
  );

  return (
    <a {...linkProps} aria-current={undefined}>
      {children}
    </a>
  );
}

function BreadcrumbOverflowMenu({
  items,
  className,
}: {
  items: readonly MainBreadcrumbNavigableItem[];
  className?: string;
}) {
  const t = useT();
  const routeChangeOwnsFocus = useRef(false);

  const markRouteChange = () => {
    routeChangeOwnsFocus.current = true;
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="main-breadcrumb-overflow-trigger"
          aria-label={t("header.mainBreadcrumb.showParents")}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
            className,
          )}
        >
          <DotsHorizontal size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-w-64"
        onCloseAutoFocus={(event) => {
          if (routeChangeOwnsFocus.current) event.preventDefault();
          routeChangeOwnsFocus.current = false;
        }}
      >
        {items.map((item) =>
          isMainBreadcrumbLinkItem(item) ? (
            <DropdownMenuItem key={item.id} asChild onSelect={markRouteChange}>
              <BreadcrumbRouterLink item={item}>
                {item.icon ? <span aria-hidden>{item.icon}</span> : null}
                <span dir="auto" className="truncate" title={item.label}>
                  {item.label}
                </span>
              </BreadcrumbRouterLink>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              key={item.id}
              onSelect={() => {
                markRouteChange();
                item.onSelect();
              }}
            >
              {item.icon ? <span aria-hidden>{item.icon}</span> : null}
              <span dir="auto" className="truncate" title={item.label}>
                {item.label}
              </span>
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const interactiveClassName =
  "inline-flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50";

function ItemBody({
  item,
  scope,
}: {
  item: MainBreadcrumbNavigableItem;
  scope: boolean;
}) {
  return (
    <>
      {item.icon ? (
        <span aria-hidden="true" className="shrink-0">
          {item.icon}
        </span>
      ) : null}
      {!scope || !item.icon ? (
        <span
          dir="auto"
          title={item.label}
          className={cn(
            "block min-w-0 truncate",
            scope && "max-w-20 @[640px]/main-topbar-left:max-w-44",
            !scope && "max-w-28 @[640px]/main-topbar-left:max-w-44",
          )}
        >
          {item.label}
        </span>
      ) : null}
    </>
  );
}

function NavigableItem({
  item,
  scope = false,
}: {
  item: MainBreadcrumbNavigableItem;
  scope?: boolean;
}) {
  const className = cn(
    interactiveClassName,
    scope
      ? "bg-muted/50 px-1.5 text-foreground hover:bg-accent"
      : "px-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground",
  );

  if (isMainBreadcrumbLinkItem(item)) {
    return (
      <BreadcrumbLink asChild>
        <BreadcrumbRouterLink
          item={item}
          className={className}
          aria-label={scope && item.icon ? item.label : undefined}
          title={scope && item.icon ? item.label : undefined}
        >
          <ItemBody item={item} scope={scope} />
        </BreadcrumbRouterLink>
      </BreadcrumbLink>
    );
  }

  return (
    <button
      type="button"
      className={className}
      aria-label={scope && item.icon ? item.label : undefined}
      title={scope && item.icon ? item.label : undefined}
      onClick={item.onSelect}
    >
      <ItemBody item={item} scope={scope} />
    </button>
  );
}

/**
 * Compact route breadcrumb for a `Main.Topbar.Left` region.
 *
 * The component presents data; route owners decide every label and action.
 * Only navigable parents live inside the breadcrumb landmark. The current
 * route remains a sibling page title instead of repeating the final breadcrumb
 * segment. The nearest parent stays visible while earlier ancestors remain
 * actionable from one stable overflow menu. The scope — an organization or a
 * project — is an accessible Home icon, avoiding a second copy of a name the
 * persistent sidebar already carries. When that scope is itself current, the
 * whole visual trail is omitted; a visually hidden heading remains as the
 * route's semantic title and focus destination.
 */
function MainBreadcrumbRoot({
  scope,
  ancestors = [],
  current,
  className,
  ariaLabel,
  compactTitle = "visible",
}: MainBreadcrumbProps) {
  const t = useT();
  const routePathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const routeFocusIdentity = `${routePathname}:${current.id}`;
  const scopeIsCurrent = isMainBreadcrumbScopeCurrent(scope, current);

  if (scopeIsCurrent) {
    return (
      <Main.Title
        key={routeFocusIdentity}
        dir="auto"
        data-route-focus-identity={routeFocusIdentity}
        data-route-focus-pathname={routePathname}
        className="sr-only"
      >
        <Main.Title.Target
          fallback={<span title={current.label}>{current.label}</span>}
        />
      </Main.Title>
    );
  }

  const currentIcon = current.icon;
  return (
    <Main.Breadcrumb.Parent.Target>
      {({ present: dynamicParentPresent, target: dynamicParentTarget }) => {
        const { inline: inlineAncestor, overflow: overflowAncestors } =
          resolveMainBreadcrumbAncestorPresentation(
            scope.id,
            ancestors,
            current.id,
            dynamicParentPresent,
          );
        const hasVisibleParent =
          dynamicParentPresent || Boolean(inlineAncestor);

        return (
          <div
            data-slot="main-breadcrumb-row"
            data-responsive-focus-group="main-route-navigation"
            className={cn("flex min-w-0 flex-1 items-center gap-2", className)}
          >
            <Breadcrumb
              aria-label={ariaLabel ?? t("header.mainBreadcrumb.ariaLabel")}
              data-slot="main-breadcrumb"
              className="hidden min-w-0 shrink md:block"
            >
              <BreadcrumbList className="w-full gap-0.5 whitespace-nowrap text-sm sm:gap-0.5">
                <BreadcrumbItem
                  data-slot="main-breadcrumb-scope"
                  className="shrink-0 gap-0.5"
                >
                  <NavigableItem item={scope} scope />
                </BreadcrumbItem>

                {hasVisibleParent ? <BreadcrumbSeparator /> : null}
                {overflowAncestors.length > 0 ? (
                  <>
                    <BreadcrumbItem className="shrink-0 gap-0.5">
                      <BreadcrumbOverflowMenu items={overflowAncestors} />
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                  </>
                ) : null}
                {inlineAncestor ? (
                  <BreadcrumbItem
                    data-slot="main-breadcrumb-ancestor"
                    className="min-w-0 gap-0.5"
                  >
                    <NavigableItem item={inlineAncestor} />
                  </BreadcrumbItem>
                ) : null}
                <BreadcrumbItem
                  key="dynamic-parent-target"
                  data-slot="main-breadcrumb-dynamic-parent"
                  aria-hidden={dynamicParentPresent ? undefined : true}
                  className={cn(
                    "min-w-0 gap-0.5",
                    !dynamicParentPresent && "hidden",
                  )}
                >
                  {dynamicParentTarget}
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>

            <span
              aria-hidden="true"
              data-slot="main-breadcrumb-current-separator"
              className="hidden h-4 w-px shrink-0 bg-border/80 md:block"
            />
            <Main.Title
              key={routeFocusIdentity}
              dir="auto"
              data-route-focus-identity={routeFocusIdentity}
              data-route-focus-pathname={routePathname}
              className={cn(
                "min-w-12 flex-1",
                compactTitle === "visually-hidden" && "sr-only md:not-sr-only",
              )}
            >
              <Main.Title.Target
                fallback={
                  <span title={current.label} className="contents">
                    {currentIcon ? (
                      <span
                        aria-hidden="true"
                        className="mr-1.5 inline-flex align-middle"
                      >
                        {currentIcon}
                      </span>
                    ) : null}
                    {current.label}
                  </span>
                }
              />
            </Main.Title>
          </div>
        );
      }}
    </Main.Breadcrumb.Parent.Target>
  );
}

function MainBreadcrumbParentPortal({
  item,
}: {
  item: MainBreadcrumbNavigableItem;
}) {
  return (
    <Main.Breadcrumb.Parent.Portal>
      <NavigableItem item={item} />
    </Main.Breadcrumb.Parent.Portal>
  );
}

export const MainBreadcrumb = Object.assign(MainBreadcrumbRoot, {
  Parent: {
    Portal: MainBreadcrumbParentPortal,
  },
});
