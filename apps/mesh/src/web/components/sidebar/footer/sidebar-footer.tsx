import { AccountPopover } from "@/web/components/account-popover";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { Settings02, UserPlus01 } from "@untitledui/icons";
import { InviteMemberDialog } from "@/web/components/invite-member-dialog";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { LinkedDesktopIndicator } from "@/web/components/header/linked-desktop-indicator";
import { SidebarTopActions } from "@/web/components/sidebar/top-actions";

function SettingsIconButton() {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  return (
    <button
      type="button"
      aria-label="Settings"
      onClick={() =>
        navigate({ to: "/$org/settings", params: { org: org.slug } })
      }
      className="shrink-0 flex items-center justify-center size-7 rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
    >
      <Settings02 size={15} />
    </button>
  );
}

function SidebarExtraActions() {
  return (
    <SidebarMenu className="gap-0.5">
      <SidebarMenuItem>
        <InviteMemberDialog
          trigger={
            <SidebarMenuButton tooltip="Invite members">
              <UserPlus01 />
              <span>Invite members</span>
            </SidebarMenuButton>
          }
        />
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/**
 * Sidebar footer: org-wide actions + the account row. (The old global "Inbox"
 * was removed — invitations now live in the org switcher, join requests in
 * Settings, and release updates in the floating release card.)
 */
export function SidebarAccountFooter() {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";

  if (isCollapsed) {
    return (
      <SidebarFooter className="px-2 pb-3 gap-1">
        <SidebarExtraActions />
        <SidebarTopActions />
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex justify-center">
              <LinkedDesktopIndicator />
            </div>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <AccountPopover />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    );
  }

  return (
    <SidebarFooter className="px-2 pb-3 gap-0.5">
      <SidebarExtraActions />
      <SidebarTopActions />
      <SidebarMenu className="gap-0.5">
        <SidebarMenuItem>
          <LinkedDesktopIndicator variant="full" />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <div className="flex items-center gap-1">
            <div className="flex-1 min-w-0">
              <AccountPopover />
            </div>
            <SettingsIconButton />
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}
