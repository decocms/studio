import { AccountPopover } from "@/components/account-popover";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@decocms/ui/components/sidebar.tsx";
import { Settings02, UserPlus01, ZapSquare } from "@untitledui/icons";
import { useState } from "react";
import { InviteMemberDialog } from "@/components/invite-member-dialog";
import { AddConnectionDialog } from "@/views/virtual-mcp/add-connection-dialog";
import { useProjectContext } from "@/sdk";
import { useNavigate } from "@tanstack/react-router";
import { SidebarTopActions } from "@/components/sidebar/top-actions";
import { useReportsOnly } from "@/hooks/use-organization-settings";
import { useT } from "@/i18n/use-t";

function SettingsFullButton() {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  return (
    <SidebarMenuButton
      tooltip={t("sidebar.sidebarFooter.settings")}
      onClick={() =>
        navigate({
          to: "/$org/settings",
          params: { org: org.slug },
        })
      }
    >
      <Settings02 />
      <span>{t("sidebar.sidebarFooter.settings")}</span>
    </SidebarMenuButton>
  );
}

function SettingsIconButton() {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  return (
    <button
      type="button"
      aria-label={t("sidebar.sidebarFooter.settings")}
      onClick={() =>
        navigate({ to: "/$org/settings", params: { org: org.slug } })
      }
      className="shrink-0 flex items-center justify-center size-7 rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
    >
      <Settings02 size={15} />
    </button>
  );
}

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
      <AddConnectionDialog
        open={connectionsOpen}
        onOpenChange={setConnectionsOpen}
        mode="browse"
      />
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

/**
 * Account footer — extra actions (invite / connections, trimmed to invite-only
 * for reports-only orgs) and the account row with Settings tucked into a
 * bottom-right icon (no full-width Settings row). The credits chip only shows
 * outside reports-only orgs.
 */
export function SidebarAccountFooter() {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";
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
      {showCredits && <SidebarTopActions />}
      {reportsOnly ? <SidebarExtraActionsCommerce /> : <SidebarExtraActions />}
      <SidebarMenu className="gap-0.5">
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
