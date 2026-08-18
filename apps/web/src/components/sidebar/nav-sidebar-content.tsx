/**
 * The sidebar body for orgs on the first-class navigation (see `useNavV2`):
 * destinations, not threads.
 *
 * Expanded, the body is just the destination list — the collapse trigger sits
 * beside the org selector in the sidebar header, and new chat / chat search
 * live in the chat panel (NewChatCrumb and ThreadsMenu). Collapsed, the header
 * is hidden, so this reproduces the org icon and the trigger as an icon rail.
 */

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@decocms/ui/components/sidebar.tsx";
import { LayoutLeft } from "@untitledui/icons";
import { useProjectContext } from "@/sdk";
import { OrgIcon, OrgSwitcherPopover } from "@/components/header/org-switcher";
import { useT } from "@/i18n/use-t.ts";
import { NavDestinationsContent } from "./nav-destinations";

export function NavSidebarContent({
  onNavigate,
}: {
  onNavigate?: () => void;
} = {}) {
  const t = useT();
  const { org } = useProjectContext();
  const { state, isMobile, toggleSidebar } = useSidebar();

  const isCollapsed = state === "collapsed" && !isMobile;
  const destinations = <NavDestinationsContent onNavigate={onNavigate} />;

  if (isCollapsed) {
    return (
      <div className="flex flex-col min-h-0 flex-1 -mt-1 w-[calc(var(--sidebar-width-icon)-1rem)]">
        <div className="flex h-12 shrink-0 items-center justify-center">
          <OrgSwitcherPopover
            orgParam={org.slug}
            side="right"
            align="start"
            trigger={
              <SidebarMenuButton tooltip={org.name}>
                <OrgIcon org={org} size="sm" />
              </SidebarMenuButton>
            }
          />
        </div>
        <SidebarMenu className="mt-2 gap-1.5">
          <SidebarMenuItem>
            <SidebarMenuButton
              aria-label={t("sidebar.taskGroupsList.toggleSidebar")}
              tooltip={t("sidebar.taskGroupsList.toggleSidebar")}
              onClick={toggleSidebar}
            >
              <LayoutLeft size={16} />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="mt-1.5 min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {destinations}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto">{destinations}</div>
    </div>
  );
}
