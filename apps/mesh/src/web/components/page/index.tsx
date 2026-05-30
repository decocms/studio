import { SidebarTrigger } from "@deco/ui/components/sidebar.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import type { PropsWithChildren, ReactElement, ReactNode } from "react";
import { Children, createContext, isValidElement, useContext } from "react";

// Context for providing default className to Page.Content from a parent layout
const PageContentDefaultClassNameContext = createContext<string | undefined>(
  undefined,
);
export const PageContentClassNameProvider =
  PageContentDefaultClassNameContext.Provider;

// Helper to find child by type for slot-based composition
function findChild<T>(
  children: ReactNode,
  type: (props: T) => ReactNode,
): ReactElement<T> | null {
  const arr = Children.toArray(children);
  for (const child of arr) {
    if (isValidElement(child) && child.type === type) {
      return child as ReactElement<T>;
    }
  }
  return null;
}

// Root page container
function PageRoot({
  children,
  className,
}: PropsWithChildren<{ className?: string }>) {
  return (
    <div
      className={cn(
        "flex flex-col h-full w-full bg-background overflow-hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

// Page header with slot-based composition
function PageHeader({
  children,
  className,
  hideSidebarTrigger,
}: PropsWithChildren<{ className?: string; hideSidebarTrigger?: boolean }>) {
  const left = findChild(children, PageHeaderLeft);
  const right = findChild(children, PageHeaderRight);

  return (
    <div
      className={cn(
        "shrink-0 w-full border-b border-border/50 h-11",
        "flex items-center justify-between gap-3 pr-2 pl-2 md:pl-4",
        className,
      )}
    >
      <div className="flex items-center gap-1 min-w-0 flex-1">
        {!hideSidebarTrigger && (
          <SidebarTrigger className="md:hidden shrink-0" />
        )}
        {left}
      </div>
      <div className="flex items-center">{right}</div>
    </div>
  );
}

// Left slot for title, breadcrumbs, etc.
function PageHeaderLeft({
  children,
  className,
}: PropsWithChildren<{ className?: string }>) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 min-w-0 overflow-hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

// Right slot for actions, buttons, filters
function PageHeaderRight({
  children,
  className,
}: PropsWithChildren<{ className?: string }>) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 shrink-0 overflow-hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

// Content area with proper overflow handling
function PageContent({
  children,
  className,
}: PropsWithChildren<{ className?: string }>) {
  const defaultClassName = useContext(PageContentDefaultClassNameContext);
  return (
    <div className={cn("flex-1 overflow-auto", defaultClassName, className)}>
      {children}
    </div>
  );
}

// Page title — prominent heading for the page
function PageTitle({
  children,
  actions,
  className,
}: PropsWithChildren<{ actions?: ReactNode; className?: string }>) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3",
        className,
      )}
    >
      <div className="text-xl font-medium min-w-0">{children}</div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

// Settings page body — centers content with max-width and consistent padding
function PageBody({
  children,
  className,
  maxWidth = "max-w-[1200px]",
}: PropsWithChildren<{ className?: string; maxWidth?: string }>) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-4 pt-8 pb-6 md:px-10 md:pt-12 md:pb-10",
        maxWidth,
        className,
      )}
    >
      {children}
    </div>
  );
}

// Export with composition pattern
export const Page = Object.assign(PageRoot, {
  Header: Object.assign(PageHeader, {
    Left: PageHeaderLeft,
    Right: PageHeaderRight,
  }),
  Content: PageContent,
  Title: PageTitle,
  Body: PageBody,
});
