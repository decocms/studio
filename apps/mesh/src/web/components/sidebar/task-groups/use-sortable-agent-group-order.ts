import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { TaskGroupData } from "./group-threads";
import {
  buildStoredOrderAfterReorder,
  canReorderAcrossSections,
  reorderGroupIds,
  saveGroupOrder,
  saveOrgGroupOrder,
  sortableGroupIdsForSection,
  type SidebarGroupSection,
  type SidebarOrderScope,
} from "./stable-order";
import { track } from "@/web/lib/posthog-client";

export type SortableAgentGroupSurface = "expanded" | "collapsed_rail";

export function useSortableAgentGroupOrder(
  sectionGroups: TaskGroupData[],
  section: SidebarGroupSection,
  orderScope: SidebarOrderScope,
  decopilotId: string,
  orgPinnedIds: string[],
  onReorder: () => void,
  surface: SortableAgentGroupSurface = "expanded",
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

    if (!canReorderAcrossSections(activeId, overId, orgPinnedIds)) return;

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
