import { useProjectContext } from "@decocms/mesh-sdk";
import type { SidebarSection } from "@/web/components/sidebar/types";
import { useSidebar } from "@deco/ui/components/sidebar.tsx";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
} from "@deco/ui/components/sidebar.tsx";
import { NewThreadRailButton } from "@/web/components/sidebar/new-thread-rail-button";

export function useProjectSidebarItems(): SidebarSection[] {
  const { org: _org } = useProjectContext();
  const { state, isMobile } = useSidebar();
  const isCollapsed = !isMobile && state === "collapsed";

  const sections: SidebarSection[] = [];

  if (isCollapsed) {
    sections.push({
      type: "custom",
      key: "new-task",
      content: (
        <SidebarGroup className="pt-0 pr-0 pb-0 pl-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1.5">
              <NewThreadRailButton />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ),
    });
  }

  return sections;
}
