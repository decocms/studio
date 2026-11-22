import {
  SidebarFooter as SidebarFooterInner,
  SidebarMenu,
  SidebarMenuItem,
} from "./sidebar.tsx";
import { cn } from "../lib/utils.ts";
import type { ReactNode } from "react";

interface SidebarFooterShellProps {
  children: ReactNode;
  className?: string;
}

export function SidebarFooterShell({
  children,
  className,
}: SidebarFooterShellProps) {
  return (
    <SidebarFooterInner className={cn("bg-sidebar pt-(--space-m)", className)}>
      <SidebarMenu>
        <SidebarMenuItem>{children}</SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooterInner>
  );
}

// Skeleton for sidebar footer
SidebarFooterShell.Skeleton = function SidebarFooterShellSkeleton() {
  return (
    <SidebarFooterInner className="bg-sidebar pt-(--space-m)">
      <SidebarMenu>
        <SidebarMenuItem>
          <div className="flex items-center justify-center gap-(--space-xs) p-(--space-xs)">
            <div className="w-24 h-8 bg-muted rounded-(--radius-s) animate-pulse" />
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooterInner>
  );
};
