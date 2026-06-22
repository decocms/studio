import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import type { ReactNode } from "react";
import type { NavigationSidebarItem, SidebarSection } from "./types";
import { SidebarCollapsibleGroup } from "./sidebar-group";
import { track } from "@/web/lib/posthog-client";

interface NavigationSidebarProps {
  sections: SidebarSection[];
  header?: ReactNode;
  footer?: ReactNode;
  additionalContent?: ReactNode;
  variant?: "sidebar" | "floating" | "inset";
  /** Additional classes for the content area */
  contentClassName?: string;
}

function SidebarNavigationItem({ item }: { item: NavigationSidebarItem }) {
  const { isMobile, setOpenMobile } = useSidebar();

  const handleClick = () => {
    track("nav_item_clicked", {
      nav_key: item.key,
      nav_label: item.label,
      is_active: !!item.isActive,
      is_mobile: isMobile,
    });
    item.onClick?.();
    if (isMobile) setOpenMobile(false);
  };

  return (
    <SidebarMenuItem key={item.key} className={cn(item.isActive && "z-10")}>
      <SidebarMenuButton
        onClick={handleClick}
        isActive={item.isActive}
        tooltip={item.label}
      >
        {item.icon}
        <span>{item.label}</span>
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
        <SidebarGroup className="pt-0 pr-0 pb-0 pl-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1.5">
              {section.items.map((item) => (
                <SidebarNavigationItem key={item.key} item={item} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      );
    case "custom":
      return section.content;
  }
}

/**
 * Generic navigation sidebar that can be used for any context (projects, orgs, etc.)
 * Accepts sections (items, groups, dividers) and optional footer/additional content.
 */
function NavigationSidebarInner({
  sections,
  header,
  footer,
  additionalContent,
  variant = "sidebar",
  contentClassName,
}: NavigationSidebarProps) {
  return (
    <Sidebar variant={variant}>
      {header}
      <SidebarContent
        className={cn(
          "flex flex-col flex-1 px-2 py-2 gap-0.5",
          contentClassName,
        )}
      >
        {sections.map((section, index) => (
          <SidebarSectionRenderer key={index} section={section} />
        ))}
        {additionalContent && (
          <div className="flex flex-col flex-1 min-h-0 group-data-[state=collapsed]/sidebar:mt-1 group-data-[state=expanded]/sidebar:mt-2">
            {additionalContent}
          </div>
        )}
      </SidebarContent>
      {footer}
    </Sidebar>
  );
}

/**
 * Generic navigation sidebar that can be used for any context (projects, orgs, etc.)
 * Accepts sections (items, groups, dividers) and optional footer/additional content.
 */
export function NavigationSidebar(props: NavigationSidebarProps) {
  return <NavigationSidebarInner {...props} />;
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
