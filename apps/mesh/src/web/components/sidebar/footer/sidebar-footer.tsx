import { AccountPopover } from "@/web/components/account-popover";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { Settings02, UserPlus01, ZapSquare } from "@untitledui/icons";
import { useState } from "react";
import { InviteMemberDialog } from "@/web/components/invite-member-dialog";
import { AddConnectionDialog } from "@/web/views/virtual-mcp/add-connection-dialog";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { LinkedDesktopIndicator } from "@/web/components/header/linked-desktop-indicator";
import { SidebarTopActions } from "@/web/components/sidebar/top-actions";
import { useReportsOnly } from "@/web/hooks/use-organization-settings";

function SettingsFullButton() {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  return (
    <SidebarMenuButton
      tooltip="Settings"
      onClick={() =>
        navigate({
          to: "/$org/settings",
          params: { org: org.slug },
        })
      }
    >
      <Settings02 />
      <span>Settings</span>
    </SidebarMenuButton>
  );
}

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

/** Quick actions in the footer: invite members + add connection. */
function SidebarInviteAction() {
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  return (
    <>
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
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip="Add connection"
            onClick={() => setConnectionsOpen(true)}
          >
            <ZapSquare />
            <span>Add connection</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <AddConnectionDialog
        open={connectionsOpen}
        onOpenChange={setConnectionsOpen}
        mode="browse"
      />
    </>
  );
}

/**
 * Account footer — Invite members + Add connection, the desktop-link
 * indicator, and the account row with Settings tucked into a bottom-right icon
 * (no full-width Settings row). The credits chip only shows outside
 * reports-only orgs.
 */
export function SidebarAccountFooter() {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";
  const reportsOnly = useReportsOnly();
  const showCredits = !reportsOnly;

  if (isCollapsed) {
    return (
      <SidebarFooter className="px-2 pb-3 gap-1">
        <SidebarInviteAction />
        {showCredits && <SidebarTopActions />}
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex justify-center">
              <LinkedDesktopIndicator />
            </div>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SettingsFullButton />
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
      <SidebarInviteAction />
      {showCredits && <SidebarTopActions />}
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
