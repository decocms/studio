import { useNavigate } from "@tanstack/react-router";
import { Locator, useProjectContext } from "@decocms/mesh-sdk";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@deco/ui/components/sidebar.tsx";
import { Settings02 } from "@untitledui/icons";
import { useRouterState } from "@tanstack/react-router";

export function SidebarSettingsFooter() {
  const { locator } = useProjectContext();
  const navigate = useNavigate();
  const routerState = useRouterState();

  const currentPath = routerState.location.pathname;
  const isActive = currentPath.includes("/settings");

  const handleClick = () => {
    navigate({
      to: "/$org/$project/settings",
      params: Locator.parse(locator),
    });
  };

  return (
    <SidebarFooter className="py-2 border-r">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            className="group/nav-item cursor-pointer text-foreground/90 hover:text-foreground"
            onClick={handleClick}
            isActive={isActive}
            tooltip="Settings"
          >
            <span className="text-muted-foreground group-hover/nav-item:text-foreground transition-colors [&>svg]:size-4">
              <Settings02 />
            </span>
            <span className="truncate">Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}
