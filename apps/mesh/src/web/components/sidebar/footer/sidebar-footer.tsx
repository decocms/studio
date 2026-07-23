import { AccountPopover } from "@/web/components/account-popover";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { Link01, Settings02, UserPlus01, ZapSquare } from "@untitledui/icons";
import { useState } from "react";
import { InviteMemberDialog } from "@/web/components/invite-member-dialog";
import { AddConnectionDialog } from "@/web/views/virtual-mcp/add-connection-dialog";
import { ConnectDialog } from "@/web/components/connect/connect-dialog";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { LinkedDesktopIndicator } from "@/web/components/header/linked-desktop-indicator";
import { SidebarTopActions } from "@/web/components/sidebar/top-actions";
import { useReportsOnly } from "@/web/hooks/use-organization-settings";
import { useT } from "@/web/i18n/use-t";
import { track } from "@/web/lib/posthog-client";

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

function SidebarExtraActions() {
  const t = useT();
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [connectClaudeOpen, setConnectClaudeOpen] = useState(false);
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
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip="Connect to Claude"
            onClick={() => {
              track("connect_studio_opened", { source: "sidebar_footer" });
              setConnectClaudeOpen(true);
            }}
          >
            <Link01 />
            <span>Connect to Claude</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <AddConnectionDialog
        open={connectionsOpen}
        onOpenChange={setConnectionsOpen}
        mode="browse"
      />
      <ConnectDialog
        open={connectClaudeOpen}
        onOpenChange={setConnectClaudeOpen}
      />
    </>
  );
}

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

export function SidebarAccountFooter() {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";
  const reportsOnly = useReportsOnly();

  if (reportsOnly) {
    if (isCollapsed) {
      return (
        <SidebarFooter className="px-2 pb-3 gap-1">
          <SidebarExtraActionsCommerce />
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
        <SidebarExtraActionsCommerce />
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
      <SidebarExtraActions />
      <SidebarTopActions />
      <SidebarMenu className="gap-0.5">
        <SidebarMenuItem>
          <LinkedDesktopIndicator variant="full" />
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
