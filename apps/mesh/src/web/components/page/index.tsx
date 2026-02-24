import { SidebarTrigger } from "@deco/ui/components/sidebar.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import type { PropsWithChildren, ReactElement, ReactNode } from "react";
import { Children, isValidElement } from "react";

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
        "flex flex-col h-full bg-background overflow-hidden",
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
        "shrink-0 w-full border-b border-border/50 h-11 overflow-x-auto",
        "flex items-center justify-between gap-3 pr-4 min-w-max",
        hideSidebarTrigger ? "pl-4" : "pl-2",
        className,
      )}
    >
      <div className="flex items-center gap-1">
        {!hideSidebarTrigger && (
          <SidebarTrigger className="text-muted-foreground" />
        )}
        {left}
      </div>
      {right}
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
        "flex items-center gap-2 shrink-0 overflow-hidden",
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
        "flex items-center gap-2 shrink-0 overflow-hidden border-l border-border pl-3",
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
  return (
    <div className={cn("flex-1 overflow-auto", className)}>{children}</div>
  );
}

// Export with composition pattern
export const Page = Object.assign(PageRoot, {
  Header: Object.assign(PageHeader, {
    Left: PageHeaderLeft,
    Right: PageHeaderRight,
  }),
  Content: PageContent,
});
