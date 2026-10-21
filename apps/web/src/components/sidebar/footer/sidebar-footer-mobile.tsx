import { AccountPopover } from "@/components/account-popover";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
} from "@decocms/ui/components/sidebar.tsx";
import { useProjectFirstNav } from "@/hooks/use-preferences";
import { InboxIconButton } from "./inbox";
import { SettingsIconButton } from "./settings-button";

/** The mobile account footer. Settings sits beside the inbox only under
 *  project-first navigation, which drops the sidebar's `NavSettingsRow`; with
 *  that row present a second door here would land somewhere else. */
export function SidebarAccountFooterMobile() {
  const projectFirstNav = useProjectFirstNav();
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
        {projectFirstNav && <SettingsIconButton />}
        <InboxIconButton />
      </div>
    </SidebarFooter>
  );
}
