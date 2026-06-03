import type { TaskGroupData } from "./group-threads";
import {
  CollapsedGroupPopover,
  type CollapsedGroupPopoverProps,
} from "./collapsed-group-popover";
import type { SidebarOrderScope } from "./stable-order";
import { AgentGroupsSortableLayout } from "./sortable-agent-groups-layout";

export interface SortableCollapsedTaskGroupsProps {
  groups: TaskGroupData[];
  orderScope: SidebarOrderScope;
  decopilotId: string;
  orgPinnedIds: string[];
  onReorder: () => void;
  renderGroup: (group: TaskGroupData) => CollapsedGroupPopoverProps;
}

export function SortableCollapsedTaskGroups({
  groups,
  orderScope,
  decopilotId,
  orgPinnedIds,
  onReorder,
  renderGroup,
}: SortableCollapsedTaskGroupsProps) {
  return (
    <AgentGroupsSortableLayout
      groups={groups}
      orderScope={orderScope}
      decopilotId={decopilotId}
      orgPinnedIds={orgPinnedIds}
      onReorder={onReorder}
      surface="collapsed_rail"
      collapsedSeparator
      renderGroup={renderGroup}
      renderFixed={(props) => (
        <CollapsedGroupPopover key={props.virtualMcpId} {...props} />
      )}
      renderSortable={(props, sortable) => (
        <CollapsedGroupPopover
          key={props.virtualMcpId}
          {...props}
          sortable={{
            attributes: sortable.attributes,
            listeners: sortable.listeners,
            isDragging: sortable.isDragging,
          }}
        />
      )}
    />
  );
}
