import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Columns03 } from "@untitledui/icons";
import type { SidebarSection } from "@/web/components/sidebar/types";
import { useSidebar } from "@deco/ui/components/sidebar.tsx";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
} from "@deco/ui/components/sidebar.tsx";
import { BrowseAgentsButton } from "@/web/components/sidebar/browse-agents-button";
import { useTaskBoardEnabled } from "@/web/hooks/use-organization-settings";

export function useProjectSidebarItems(): SidebarSection[] {
  const { org } = useProjectContext();
  const { state, isMobile } = useSidebar();
  const isCollapsed = !isMobile && state === "collapsed";
  const navigate = useNavigate();
  const taskBoardEnabled = useTaskBoardEnabled();

  const sections: SidebarSection[] = [];

  if (taskBoardEnabled) {
    sections.push({
      type: "items",
      items: [
        {
          key: "board",
          label: "Board",
          icon: <Columns03 className="size-4!" />,
          onClick: () =>
            navigate({ to: "/$org/board", params: { org: org.slug } }),
        },
      ],
    });
  }

  if (isCollapsed) {
    sections.push({
      type: "custom",
      key: "new-task",
      content: (
        <SidebarGroup className="pt-0 pr-0 pb-0 pl-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1.5">
              <BrowseAgentsButton />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ),
    });
  }

  return sections;
}
