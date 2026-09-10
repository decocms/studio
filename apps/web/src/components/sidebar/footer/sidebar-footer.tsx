import { AccountPopover } from "@/components/account-popover";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@decocms/ui/components/sidebar.tsx";
import { UserPlus01, ZapSquare } from "@untitledui/icons";
import { useState } from "react";
import { InviteMemberDialog } from "@/components/invite-member-dialog";
import { AddConnectionDialog } from "@/views/virtual-mcp/add-connection-dialog";
import { SidebarTopActions } from "@/components/sidebar/top-actions";
import { useReportsOnly } from "@/hooks/use-organization-settings";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { useT } from "@/i18n/use-t";
import { InboxFullButton, InboxIconButton } from "./inbox";

/** Quick actions in the footer: invite members, add connection. */
function SidebarExtraActions() {
  const t = useT();
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  return (
    <>
      <SidebarMenu className="gap-0.5">
        <SidebarMenuItem>
          <InviteMemberDialog
            trigger={
              <SidebarMenuButton
                tooltip={t("sidebar.sidebarFooter.inviteMembers")}
              >
                <UserPlus01 />
                <span>{t("sidebar.sidebarFooter.inviteMembers")}</span>
              </SidebarMenuButton>
            }
          />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip={t("sidebar.sidebarFooter.addConnection")}
            onClick={() => setConnectionsOpen(true)}
          >
            <ZapSquare />
            <span>{t("sidebar.sidebarFooter.addConnection")}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {/* Mounted only while open: its body calls useConnectionActions, which
          suspends on the self-MCP connect, and nothing between here and the
          router root catches that — so an unopened dialog blanked the app. */}
      {connectionsOpen && (
        <AddConnectionDialog
          open={connectionsOpen}
          onOpenChange={setConnectionsOpen}
          mode="browse"
        />
      )}
    </>
  );
}

/** Commerce (reports-only) orgs get a trimmed footer: invite members only. */
function SidebarExtraActionsCommerce() {
  const t = useT();
  return (
    <SidebarMenu className="gap-0.5">
      <SidebarMenuItem>
        <InviteMemberDialog
          trigger={
            <SidebarMenuButton
              tooltip={t("sidebar.sidebarFooter.inviteMembers")}
            >
              <UserPlus01 />
              <span>{t("sidebar.sidebarFooter.inviteMembers")}</span>
            </SidebarMenuButton>
          }
        />
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** Account footer — extra actions (invite / connections, trimmed to
 *  invite-only for reports-only orgs) and the account row. Settings is a
 *  destination row now, so it is not repeated here. The credits chip only
 *  shows outside reports-only orgs. */
export function SidebarAccountFooter() {
  const isCollapsed = useSidebarCollapsed();
  const reportsOnly = useReportsOnly();
  const showCredits = !reportsOnly;

  if (isCollapsed) {
    return (
      <SidebarFooter className="px-2 pb-3 gap-1">
        {showCredits && <SidebarTopActions />}
        {reportsOnly ? (
          <SidebarExtraActionsCommerce />
        ) : (
          <SidebarExtraActions />
        )}
        <SidebarMenu>
          <SidebarMenuItem>
            <InboxFullButton />
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
      {showCredits && <SidebarTopActions />}
      {reportsOnly ? <SidebarExtraActionsCommerce /> : <SidebarExtraActions />}
      <SidebarMenu className="gap-0.5">
        <SidebarMenuItem>
          <div className="flex items-center gap-1">
            <div className="flex-1 min-w-0">
              <AccountPopover />
            </div>
            <InboxIconButton />
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}
