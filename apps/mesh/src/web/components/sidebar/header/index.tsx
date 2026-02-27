import {
  SidebarHeader as SidebarHeaderUI,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { LayoutLeft } from "@untitledui/icons";
import { MeshAccountSwitcher } from "./account-switcher";

interface MeshSidebarHeaderProps {
  onCreateProject?: () => void;
}

export function MeshSidebarHeader({ onCreateProject }: MeshSidebarHeaderProps) {
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";

  return (
    <SidebarHeaderUI className="px-3 group-data-[collapsible=icon]:px-2 animate-in fade-in-0 duration-200">
      <SidebarMenu>
        <SidebarMenuItem>
          {isCollapsed ? (
            <div className="flex flex-col w-full gap-0.5">
              <MeshAccountSwitcher
                isCollapsed={true}
                onCreateProject={onCreateProject}
              />
              <SidebarMenuButton
                onClick={toggleSidebar}
                tooltip="Expand sidebar"
              >
                <LayoutLeft />
              </SidebarMenuButton>
            </div>
          ) : (
            <div className="flex items-center justify-between w-full gap-1">
              <div className="min-w-0 flex-1">
                <MeshAccountSwitcher
                  isCollapsed={false}
                  onCreateProject={onCreateProject}
                />
              </div>
              <SidebarMenuButton
                onClick={toggleSidebar}
                tooltip="Collapse sidebar"
                className="size-7 shrink-0"
              >
                <LayoutLeft />
              </SidebarMenuButton>
            </div>
          )}
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeaderUI>
  );
}

MeshSidebarHeader.Skeleton = function MeshSidebarHeaderSkeleton() {
  return (
    <SidebarHeaderUI className="px-3">
      <SidebarMenu>
        <SidebarMenuItem>
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-3 min-w-0 flex-1 p-1.5">
              <Skeleton className="size-8 rounded-md shrink-0 bg-sidebar-accent" />
              <Skeleton className="h-3.5 w-16 bg-sidebar-accent" />
            </div>
            <div className="flex items-center gap-0.5">
              <Skeleton className="size-7 rounded-lg bg-sidebar-accent" />
            </div>
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeaderUI>
  );
};
