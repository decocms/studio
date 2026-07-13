import type { TaskGroupData } from "./group-threads";
import type { SidebarOrderScope } from "./stable-order";
import { AgentGroupsSortableLayout } from "./sortable-agent-groups-layout";
import { AgentRow, type AgentRowProps } from "./agent-row";

export interface SortableAgentRowsProps {
  groups: TaskGroupData[];
  orderScope: SidebarOrderScope;
  decopilotId: string;
  orgPinnedIds: string[];
  onReorder: () => void;
  renderGroup: (group: TaskGroupData) => AgentRowProps;
}

/**
 * Flat, draggable list of agents (one row per agent). Reuses the shared
 * `AgentGroupsSortableLayout` so decopilot-pinning, org-pinned/user sections,
 * and drag-to-reorder behave exactly as they did for the old grouped view —
 * only the rendered item changed from a thread group to a single agent row.
 */
export function SortableAgentRows({
  groups,
  orderScope,
  decopilotId,
  orgPinnedIds,
  onReorder,
  renderGroup,
}: SortableAgentRowsProps) {
  return (
    <AgentGroupsSortableLayout
      groups={groups}
      orderScope={orderScope}
      decopilotId={decopilotId}
      orgPinnedIds={orgPinnedIds}
      onReorder={onReorder}
      surface="expanded"
      renderGroup={renderGroup}
      renderFixed={(props) => <AgentRow key={props.virtualMcpId} {...props} />}
      renderSortable={(props, sortable) => (
        <AgentRow key={props.virtualMcpId} {...props} sortable={sortable} />
      )}
    />
  );
}
