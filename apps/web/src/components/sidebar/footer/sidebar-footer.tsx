import { AccountPopover } from "@/components/account-popover";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@decocms/ui/components/sidebar.tsx";
import { UserPlus01 } from "@untitledui/icons";
import { InviteMemberDialog } from "@/components/invite-member-dialog";
import { SidebarTopActions } from "@/components/sidebar/top-actions";
import { useReportsOnly } from "@/hooks/use-organization-settings";
import { useT } from "@/i18n/use-t";
import { InboxIconButton } from "./inbox";
import { SettingsIconButton } from "./settings-button";
import { SidebarFooterIcon, SIDEBAR_FOOTER_ICON_SIZE } from "./icon-slot";

/** The one quick action left in the footer. Connections live in their own
 *  destination, so the footer no longer offers a second door to them — which
 *  also makes commerce (reports-only) orgs and everyone else identical here. */
function SidebarExtraActions() {
  const t = useT();
  return (
    <SidebarMenu className="gap-0.5">
      <SidebarMenuItem>
        <InviteMemberDialog
          trigger={
            <SidebarMenuButton
              tooltip={t("sidebar.sidebarFooter.inviteMembers")}
            >
              <SidebarFooterIcon>
                <UserPlus01 className={SIDEBAR_FOOTER_ICON_SIZE} />
              </SidebarFooterIcon>
              <span>{t("sidebar.sidebarFooter.inviteMembers")}</span>
            </SidebarMenuButton>
          }
        />
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** Account footer — the invite action, the account row, and the controls that
 *  sit beside it: Settings and notifications. Neither control is a destination
 *  — you open it, change something and come back — which is why it is an icon
 *  on the account row rather than a row in the spine. The usage chip only shows
 *  outside reports-only orgs. */
export function SidebarAccountFooter() {
  const reportsOnly = useReportsOnly();
  const showCredits = !reportsOnly;

  return (
    <SidebarFooter className="px-2 pb-3 gap-0.5">
      {showCredits && <SidebarTopActions />}
      <SidebarExtraActions />
      <SidebarMenu className="gap-0.5">
        <SidebarMenuItem>
          <div className="flex items-center gap-1">
            <div className="flex-1 min-w-0">
              <AccountPopover />
            </div>
            <SettingsIconButton />
            <InboxIconButton />
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}
