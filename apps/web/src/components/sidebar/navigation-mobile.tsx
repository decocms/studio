import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@decocms/ui/components/sidebar.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { LayoutLeft } from "@untitledui/icons";
import type { ReactNode } from "react";
import { useT } from "@/i18n/use-t.ts";
import { SidebarCollapsibleGroup } from "./sidebar-group";
import {
  AgentSwitcherCrumb,
  OrgSwitcherCrumb,
} from "@/components/header/shell-breadcrumb";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import type { NavigationSidebarItem, SidebarSection } from "./types";

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
      {/* Mirror the desktop sidebar header: org switcher + agent switcher, so
          the agent can be changed from the mobile sheet too. Picking an agent
          closes the sheet (onNavigate) so the chosen chat is visible. */}
      <div className="flex h-12 shrink-0 items-center gap-0.5 px-1.5">
        <OrgSwitcherCrumb />
        <AgentSwitcherCrumb onNavigate={onClose} />
        <div className="flex-1" />
        <ToolbarIconButton
          onClick={onClose}
          aria-label={useT()("sidebar.navigationMobile.closeSidebar")}
        >
          <LayoutLeft size={16} />
        </ToolbarIconButton>
      </div>
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
