import { AccountPopover } from "@/web/components/account-popover";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { Settings02 } from "@untitledui/icons";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { ToolbarIconButton } from "@/web/components/toolbar-icon-button";

export function SidebarInboxFooterMobile() {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { setOpenMobile } = useSidebar();

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
        <ToolbarIconButton
          aria-label="Settings"
          onClick={() => {
            navigate({
              to: "/$org/settings",
              params: { org: org.slug },
            });
            setOpenMobile(false);
          }}
        >
          <Settings02 className="size-4" />
        </ToolbarIconButton>
      </div>
    </SidebarFooter>
  );
}
