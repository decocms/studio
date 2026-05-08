import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Suspense, type ReactNode } from "react";
import type { NavigationSidebarItem, SidebarSection } from "./types";
import { SidebarCollapsibleGroup } from "./sidebar-group";
import { DEFAULT_LOGO, usePublicConfig } from "@/web/hooks/use-public-config";
import { track } from "@/web/lib/posthog-client";

function SidebarLogoHeader() {
  const config = usePublicConfig();
  const logo = config.logo ?? DEFAULT_LOGO;
  const lightSrc = typeof logo === "string" ? logo : logo.light;
  const darkSrc = typeof logo === "string" ? logo : logo.dark;

  return (
    <SidebarHeader className="flex items-center justify-center shrink-0 px-2 pb-0">
      <div className="flex w-full aspect-square items-center justify-center">
        <img
          src={lightSrc}
          alt="Logo"
          className="size-6 object-contain dark:hidden"
        />
        <img
          src={darkSrc}
          alt="Logo"
          className="size-6 object-contain hidden dark:block"
        />
      </div>
    </SidebarHeader>
  );
}

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
        className="bg-muted/75"
      >
        {item.icon}
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
      <Suspense fallback={<div className="h-10 shrink-0" />}>
        <SidebarLogoHeader />
      </Suspense>
      {header}
      <SidebarContent
        className={cn("flex flex-col flex-1 px-2 py-2 gap-0", contentClassName)}
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
