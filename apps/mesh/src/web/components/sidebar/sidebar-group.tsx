import { useState } from "react";
import { ChevronDown } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  SidebarGroup as SidebarGroupUI,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import type { PropsWithChildren } from "react";

interface SidebarCollapsibleGroupProps extends PropsWithChildren {
  label: string;
  defaultExpanded?: boolean;
}

export function SidebarCollapsibleGroup({
  label,
  children,
  defaultExpanded = true,
}: SidebarCollapsibleGroupProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";

  return (
    <SidebarGroupUI className="pt-0 pr-0 pb-2 pl-0 mt-2">
      {isCollapsed ? (
        <div className="flex h-6 items-center">
          <div className="h-0.5 w-8 rounded-full bg-sidebar-foreground/15" />
        </div>
      ) : (
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="h-6 cursor-pointer select-none gap-1 [&>svg]:size-3"
              onClick={() => setExpanded(!expanded)}
            >
              <span className="text-xs font-medium text-muted-foreground">
                {label}
              </span>
              <ChevronDown
                size={12}
                className={cn(
                  "text-muted-foreground transition-transform duration-200",
                  !expanded && "-rotate-90",
                )}
              />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      )}
      {(isCollapsed || expanded) && (
        <SidebarGroupContent>
          <SidebarMenu className="gap-0.5">{children}</SidebarMenu>
        </SidebarGroupContent>
      )}
    </SidebarGroupUI>
  );
}
