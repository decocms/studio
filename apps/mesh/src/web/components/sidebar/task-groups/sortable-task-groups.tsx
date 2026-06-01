import type { TaskGroupProps } from "./task-group";
import { TaskGroup } from "./task-group";
import type { TaskGroupData } from "./group-threads";
import type { SidebarOrderScope } from "./stable-order";
import { AgentGroupsSortableLayout } from "./sortable-agent-groups-layout";

export interface SortableTaskGroupsProps {
  groups: TaskGroupData[];
  orderScope: SidebarOrderScope;
  decopilotId: string;
  orgPinnedIds: string[];
  onReorder: () => void;
  renderGroup: (group: TaskGroupData) => TaskGroupProps;
}

export function SortableTaskGroups({
  groups,
  orderScope,
  decopilotId,
  orgPinnedIds,
  onReorder,
  renderGroup,
}: SortableTaskGroupsProps) {
  return (
    <AgentGroupsSortableLayout
      groups={groups}
      orderScope={orderScope}
      decopilotId={decopilotId}
      orgPinnedIds={orgPinnedIds}
      onReorder={onReorder}
      surface="expanded"
      renderGroup={renderGroup}
      renderFixed={(props) => <TaskGroup key={props.virtualMcpId} {...props} />}
      renderSortable={(props, sortable) => (
        <TaskGroup key={props.virtualMcpId} {...props} sortable={sortable} />
      )}
    />
  );
}
