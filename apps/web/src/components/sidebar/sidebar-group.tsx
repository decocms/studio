import {
  SidebarGroup as SidebarGroupUI,
  SidebarGroupContent,
  SidebarMenu,
} from "@deco/ui/components/sidebar.tsx";
import type { PropsWithChildren } from "react";

interface SidebarCollapsibleGroupProps extends PropsWithChildren {
  label: string;
  defaultExpanded?: boolean;
}

export function SidebarCollapsibleGroup({
  children,
}: SidebarCollapsibleGroupProps) {
  return (
    <SidebarGroupUI className="pt-0 pr-0 pb-2 pl-0 mt-2">
      <div className="flex h-6 items-center">
        <div className="h-0.5 w-16 rounded-full bg-sidebar-foreground/15" />
      </div>
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.5">{children}</SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroupUI>
  );
}
