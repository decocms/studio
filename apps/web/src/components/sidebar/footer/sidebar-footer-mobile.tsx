import { AccountPopover } from "@/components/account-popover";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
} from "@decocms/ui/components/sidebar.tsx";
import { InboxIconButton } from "./inbox";
import { SettingsIconButton } from "./settings-button";

/** The mobile account footer: Settings and the inbox beside the account. */
export function SidebarAccountFooterMobile() {
  return (
    <SidebarFooter className="px-2 pb-3">
      <div className="flex items-center gap-1">
        <div className="flex-1 min-w-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <AccountPopover />
            </SidebarMenuItem>
          </SidebarMenu>
        </div>
        <SettingsIconButton />
        <InboxIconButton />
      </div>
    </SidebarFooter>
  );
}
