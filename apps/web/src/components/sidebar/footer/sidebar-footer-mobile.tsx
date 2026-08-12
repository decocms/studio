import { AccountPopover } from "@/components/account-popover";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from "@decocms/ui/components/sidebar.tsx";
import { Settings02 } from "@untitledui/icons";
import { useProjectContext } from "@/sdk";
import { useNavigate } from "@tanstack/react-router";
import { useT } from "@/i18n/use-t.ts";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";

export function SidebarAccountFooterMobile() {
  const t = useT();
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
          aria-label={t("sidebar.sidebarFooterMobile.settings")}
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
