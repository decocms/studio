import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { TOOL_CALL_RUNS_GROUP_KEY } from "./group-threads";
import type { TaskGroupData } from "./group-threads";
import {
  buildStoredOrderAfterReorder,
  isOrgPinnedAgent,
  reorderGroupIds,
  saveGroupOrder,
  saveOrgGroupOrder,
  sortableGroupIdsForSection,
  type SidebarGroupSection,
  type SidebarOrderScope,
} from "./stable-order";
import { track } from "@/web/lib/posthog-client";

export function isFixedAgentGroup(
  virtualMcpId: string,
  decopilotId: string,
): boolean {
  return (
    virtualMcpId === decopilotId || virtualMcpId === TOOL_CALL_RUNS_GROUP_KEY
  );
}

export function useSortableAgentGroupOrder(
  sectionGroups: TaskGroupData[],
  section: SidebarGroupSection,
  orderScope: SidebarOrderScope,
  decopilotId: string,
  orgPinnedIds: string[],
  onReorder: () => void,
  surface: "expanded" | "collapsed_rail" = "expanded",
) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const sortableIds = sortableGroupIdsForSection(
    sectionGroups,
    section,
    decopilotId,
    orgPinnedIds,
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeId = String(active.id);
    const overId = String(over.id);

    const activeIsOrg = isOrgPinnedAgent(activeId, orgPinnedIds);
    const overIsOrg = isOrgPinnedAgent(overId, orgPinnedIds);
    if (activeIsOrg !== overIsOrg) return;

    const reordered = reorderGroupIds(sortableIds, activeId, overId);
    const stored = buildStoredOrderAfterReorder(
      section,
      orderScope,
      orgPinnedIds,
      reordered,
    );

    if (section === "org") {
      saveOrgGroupOrder(orderScope.orgId, stored);
    } else {
      saveGroupOrder(orderScope, stored);
    }

    track("sidebar_group_reordered", {
      virtual_mcp_id: activeId,
      over_virtual_mcp_id: overId,
      surface,
      section,
    });
    onReorder();
  };

  return { sensors, sortableIds, handleDragEnd };
}
