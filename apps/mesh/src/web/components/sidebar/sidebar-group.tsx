import { useState } from "react";
import { ChevronDown } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  SidebarGroup as SidebarGroupUI,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
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

  return (
    <SidebarGroupUI className="py-0">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            className="h-6 cursor-pointer select-none"
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
      {expanded && (
        <SidebarGroupContent>
          <SidebarMenu className="gap-0.5">{children}</SidebarMenu>
        </SidebarGroupContent>
      )}
    </SidebarGroupUI>
  );
}
