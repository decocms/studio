import { DndContext, closestCenter } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TaskGroupData } from "./group-threads";
import {
  CollapsedGroupPopover,
  type CollapsedGroupPopoverProps,
} from "./collapsed-group-popover";
import {
  partitionDisplayGroups,
  type SidebarGroupSection,
  type SidebarOrderScope,
} from "./stable-order";
import {
  isFixedAgentGroup,
  useSortableAgentGroupOrder,
} from "./use-sortable-agent-group-order";
import { AgentGroupSectionSeparator } from "./agent-group-section-separator";

function SortableCollapsedItem(props: CollapsedGroupPopoverProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.virtualMcpId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 100 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={isDragging ? "opacity-50" : undefined}
    >
      <CollapsedGroupPopover
        {...props}
        sortable={{ attributes, listeners, isDragging }}
      />
    </div>
  );
}

function SortableCollapsedSection({
  section,
  groups,
  orderScope,
  decopilotId,
  orgPinnedIds,
  onReorder,
  renderGroup,
}: {
  section: SidebarGroupSection;
  groups: TaskGroupData[];
  orderScope: SidebarOrderScope;
  decopilotId: string;
  orgPinnedIds: string[];
  onReorder: () => void;
  renderGroup: (group: TaskGroupData) => CollapsedGroupPopoverProps;
}) {
  const { sensors, sortableIds, handleDragEnd } = useSortableAgentGroupOrder(
    groups,
    section,
    orderScope,
    decopilotId,
    orgPinnedIds,
    onReorder,
    "collapsed_rail",
  );

  if (groups.length === 0) return null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={sortableIds}
        strategy={verticalListSortingStrategy}
      >
        {groups.map((group) => {
          const props = renderGroup(group);
          if (isFixedAgentGroup(group.virtualMcpId, decopilotId)) {
            return (
              <CollapsedGroupPopover key={group.virtualMcpId} {...props} />
            );
          }
          return <SortableCollapsedItem key={group.virtualMcpId} {...props} />;
        })}
      </SortableContext>
    </DndContext>
  );
}

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
  const { decopilot, orgPinned, user, toolCallRuns } = partitionDisplayGroups(
    groups,
    decopilotId,
    orgPinnedIds,
  );
  const showSeparator = orgPinned.length > 0 && user.length > 0;

  return (
    <>
      {decopilot && (
        <CollapsedGroupPopover
          key={decopilot.virtualMcpId}
          {...renderGroup(decopilot)}
        />
      )}
      <SortableCollapsedSection
        section="org"
        groups={orgPinned}
        orderScope={orderScope}
        decopilotId={decopilotId}
        orgPinnedIds={orgPinnedIds}
        onReorder={onReorder}
        renderGroup={renderGroup}
      />
      {showSeparator && <AgentGroupSectionSeparator collapsed />}
      <SortableCollapsedSection
        section="user"
        groups={user}
        orderScope={orderScope}
        decopilotId={decopilotId}
        orgPinnedIds={orgPinnedIds}
        onReorder={onReorder}
        renderGroup={renderGroup}
      />
      {toolCallRuns && (
        <CollapsedGroupPopover
          key={toolCallRuns.virtualMcpId}
          {...renderGroup(toolCallRuns)}
        />
      )}
    </>
  );
}
