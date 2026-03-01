import { useDecoChatOpen } from "@/web/hooks/use-deco-chat-open";
import { Button } from "@deco/ui/components/button.tsx";
import { SidebarTrigger } from "@deco/ui/components/sidebar.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { MessageTextCircle02 } from "@untitledui/icons";
import { useParams, useRouterState } from "@tanstack/react-router";
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

function ChatToggleButton() {
  const [isChatOpen, setChatOpen] = useDecoChatOpen();
  const { org, project } = useParams({ strict: false });
  const { location } = useRouterState();
  const isHomeRoute =
    location.pathname === `/${org}/${project}` ||
    location.pathname === `/${org}/${project}/`;

  if (isHomeRoute) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            "h-7 px-2 gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground",
            isChatOpen && "bg-accent text-foreground",
          )}
          onClick={() => setChatOpen((prev) => !prev)}
          aria-label="Toggle Decopilot"
        >
          <MessageTextCircle02 size={14} className="text-inherit" />
          Chat
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Toggle Decopilot</TooltipContent>
    </Tooltip>
  );
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
        "flex items-center justify-between gap-3 pr-2 pl-4",
        className,
      )}
    >
      <div className="flex items-center gap-1">
        <SidebarTrigger className="md:hidden text-muted-foreground" />
        {left}
      </div>
      <div className="flex items-center">
        {right}
        {!hideSidebarTrigger && (
          <div className="flex items-center border-l border-border/50 pl-2 ml-1">
            <ChatToggleButton />
          </div>
        )}
      </div>
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
        "flex items-center gap-2 shrink-0 overflow-hidden min-w-0",
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
