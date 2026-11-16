import { AccountPopover } from "@/components/account-popover";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
} from "@decocms/ui/components/sidebar.tsx";
import { SidebarTopActions } from "@/components/sidebar/top-actions";
import { useReportsOnly } from "@/hooks/use-organization-settings";
import { InboxIconButton } from "./inbox";
import { SettingsIconButton } from "./settings-button";
import { SidebarLinkClaude } from "./link-claude";

/** Quick actions above the account row. */
function SidebarExtraActions({ showLinkClaude }: { showLinkClaude: boolean }) {
  return (
    <SidebarMenu className="gap-0.5">
      {showLinkClaude && <SidebarLinkClaude />}
    </SidebarMenu>
  );
}

/** Account footer — the quick actions, the account row, and the controls that
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
      <SidebarExtraActions showLinkClaude={!reportsOnly} />
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
