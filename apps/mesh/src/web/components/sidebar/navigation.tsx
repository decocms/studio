import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@deco/ui/components/sidebar.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import type { ReactNode } from "react";
import type { NavigationSidebarItem, SidebarSection } from "./types";
import { SidebarCollapsibleGroup } from "./sidebar-group";

interface NavigationSidebarProps {
  sections: SidebarSection[];
  header?: ReactNode;
  footer?: ReactNode;
  additionalContent?: ReactNode;
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "offcanvas" | "icon" | "none";
  /** Additional classes for the content area */
  contentClassName?: string;
}

function SidebarNavigationItem({ item }: { item: NavigationSidebarItem }) {
  return (
    <SidebarMenuItem key={item.key}>
      <SidebarMenuButton
        className="group/nav-item cursor-pointer text-foreground/90 hover:text-foreground"
        onClick={item.onClick}
        isActive={item.isActive}
        tooltip={item.label}
      >
        <span className="text-muted-foreground group-hover/nav-item:text-foreground transition-colors [&>svg]:size-4">
          {item.icon}
        </span>
        <span className="truncate">{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function SidebarSectionRenderer({ section }: { section: SidebarSection }) {
  switch (section.type) {
    case "divider":
      return <SidebarSeparator className="my-2" />;
    case "spacer":
      return <div className="flex-1" />;
    case "group":
      return (
        <SidebarCollapsibleGroup
          label={section.group.label}
          defaultExpanded={section.group.defaultExpanded}
        >
          {section.group.items.map((item) => (
            <SidebarNavigationItem key={item.key} item={item} />
          ))}
        </SidebarCollapsibleGroup>
      );
    case "items":
      return (
        <SidebarGroup className="py-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {section.items.map((item) => (
                <SidebarNavigationItem key={item.key} item={item} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      );
  }
}

/**
 * Generic navigation sidebar that can be used for any context (projects, orgs, etc.)
 * Accepts sections (items, groups, dividers) and optional footer/additional content.
 */
export function NavigationSidebar({
  sections,
  header,
  footer,
  additionalContent,
  variant = "sidebar",
  collapsible = "icon",
  contentClassName,
}: NavigationSidebarProps) {
  return (
    <Sidebar variant={variant} collapsible={collapsible}>
      {header}
      <SidebarContent
        className={cn(
          "flex flex-col flex-1 overflow-x-hidden font-medium border-r pb-2",
          contentClassName,
        )}
      >
        {sections.map((section, index) => (
          <SidebarSectionRenderer key={index} section={section} />
        ))}
        {additionalContent}
      </SidebarContent>
      {footer}
    </Sidebar>
  );
}

NavigationSidebar.Skeleton = function NavigationSidebarSkeleton() {
  return (
    <div className="flex flex-col gap-0.5">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="w-full h-8">
          <Skeleton className="h-full bg-sidebar-accent rounded-md" />
        </div>
      ))}
    </div>
  );
};
