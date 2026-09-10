import { AccountPopover } from "@/components/account-popover";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
} from "@decocms/ui/components/sidebar.tsx";
import { InboxIconButton } from "./inbox";

/** The mobile account footer. Like the desktop one it carries no Settings
 *  shortcut: `NavSettingsRow` is the sidebar's last row on both surfaces, and
 *  scoped to a project it targets that project's settings panel — a second
 *  control here pointed at the org tree instead, so the same sheet offered two
 *  Settings buttons that landed in different places. */
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
        <InboxIconButton />
      </div>
    </SidebarFooter>
  );
}
