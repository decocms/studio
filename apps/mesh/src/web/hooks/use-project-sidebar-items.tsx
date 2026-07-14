import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Columns03 } from "@untitledui/icons";
import type { SidebarSection } from "@/web/components/sidebar/types";
import { useTaskBoardEnabled } from "@/web/hooks/use-organization-settings";

/**
 * Sidebar sections rendered above the thread list. Currently empty — the
 * collapsed rail's new-thread button lives inside the thread list itself
 * (see task-groups-list), alongside the collapse toggle and thread icons.
 */
export function useProjectSidebarItems(): SidebarSection[] {
  const { org } = useProjectContext();
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

  return sections;
}
