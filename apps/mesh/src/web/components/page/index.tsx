import { useDecoChatOpen } from "@/web/hooks/use-deco-chat-open";
import { Button } from "@deco/ui/components/button.tsx";
import { SidebarTrigger } from "@deco/ui/components/sidebar.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { MessageTextCircle02 } from "@untitledui/icons";
import { useMatch, useRouterState } from "@tanstack/react-router";
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
  const isMobile = useIsMobile();
  const orgMatch = useMatch({ from: "/shell/$org", shouldThrow: false });
  const org = orgMatch?.params.org;
  const { location } = useRouterState();
  const isHomeRoute =
    location.pathname === `/${org}` || location.pathname === `/${org}/`;

  // On mobile, the FAB handles chat toggle instead
  if (isHomeRoute || isMobile) return null;

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
      <div className="flex items-center">
        {right}
        {!hideSidebarTrigger && (
          <div className="flex items-center pl-2 ml-1">
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
