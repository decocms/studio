import { DEFAULT_LOGO, usePublicConfig } from "@/web/hooks/use-public-config";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@deco/ui/components/sidebar.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { type ReactNode, Suspense } from "react";
import { SidebarCollapsibleGroup } from "./sidebar-group";
import type { NavigationSidebarItem, SidebarSection } from "./types";

function MobileLogoHeader() {
  const config = usePublicConfig();
  const logo = config.logo ?? DEFAULT_LOGO;
  const lightSrc = typeof logo === "string" ? logo : logo.light;
  const darkSrc = typeof logo === "string" ? logo : logo.dark;

  return (
    <SidebarHeader className="flex flex-row items-center shrink-0 h-12 px-3 pb-0">
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
    </SidebarHeader>
  );
}

function MobileNavigationItem({
  item,
  onClose,
}: {
  item: NavigationSidebarItem;
  onClose: () => void;
}) {
  return (
    <SidebarMenuItem className={cn(item.isActive && "z-10")}>
      <SidebarMenuButton
        onClick={() => {
          item.onClick?.();
          onClose();
        }}
        isActive={item.isActive}
        tooltip={item.label}
        className="h-10! text-sm!"
      >
        <span className="[&>svg]:size-5 shrink-0">{item.icon}</span>
        <span>{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function MobileSectionRenderer({
  section,
  onClose,
}: {
  section: SidebarSection;
  onClose: () => void;
}) {
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
            <MobileNavigationItem
              key={item.key}
              item={item}
              onClose={onClose}
            />
          ))}
        </SidebarCollapsibleGroup>
      );
    case "items":
      return (
        <SidebarGroup className="pt-0 pr-0 pb-0 pl-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1.5">
              {section.items.map((item) => (
                <MobileNavigationItem
                  key={item.key}
                  item={item}
                  onClose={onClose}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      );
    case "custom":
      return section.content;
  }
}

interface MobileNavigationSidebarProps {
  sections: SidebarSection[];
  onClose: () => void;
  footer?: ReactNode;
  additionalContent?: ReactNode;
}

/**
 * Mobile sidebar content — renders the same shadcn sidebar components as desktop
 * but without the <Sidebar> wrapper. The parent must provide `group/sidebar` class
 * and `data-state="collapsed"` for collapsed icon-only styling.
 */
export function MobileNavigationSidebar({
  sections,
  onClose,
  footer,
  additionalContent,
}: MobileNavigationSidebarProps) {
  return (
    <div
      className="bg-sidebar flex h-full w-full flex-col"
      data-sidebar="sidebar"
    >
      <Suspense fallback={<div className="h-10 shrink-0" />}>
        <MobileLogoHeader />
      </Suspense>
      <SidebarContent className="flex flex-col flex-1 px-2 py-2 gap-0">
        {sections.map((section, index) => (
          <MobileSectionRenderer
            key={index}
            section={section}
            onClose={onClose}
          />
        ))}
        {additionalContent && (
          <div className="mt-3 flex flex-col flex-1 min-h-0">
            {additionalContent}
          </div>
        )}
      </SidebarContent>
      {footer}
    </div>
  );
}
