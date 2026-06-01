import { DndContext, closestCenter } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TaskGroupProps } from "./task-group";
import { TaskGroup } from "./task-group";
import type { TaskGroupData } from "./group-threads";
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

function SortableTaskGroupItem(props: TaskGroupProps) {
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
      <TaskGroup
        {...props}
        sortableHandle={{ attributes, listeners }}
        isDragging={isDragging}
      />
    </div>
  );
}

function SortableAgentGroupSection({
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
  renderGroup: (group: TaskGroupData) => TaskGroupProps;
}) {
  const { sensors, sortableIds, handleDragEnd } = useSortableAgentGroupOrder(
    groups,
    section,
    orderScope,
    decopilotId,
    orgPinnedIds,
    onReorder,
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
            return <TaskGroup key={group.virtualMcpId} {...props} />;
          }
          return <SortableTaskGroupItem key={group.virtualMcpId} {...props} />;
        })}
      </SortableContext>
    </DndContext>
  );
}

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
  const { decopilot, orgPinned, user, toolCallRuns } = partitionDisplayGroups(
    groups,
    decopilotId,
    orgPinnedIds,
  );
  const showSeparator = orgPinned.length > 0 && user.length > 0;

  return (
    <>
      {decopilot && (
        <TaskGroup key={decopilot.virtualMcpId} {...renderGroup(decopilot)} />
      )}
      <SortableAgentGroupSection
        section="org"
        groups={orgPinned}
        orderScope={orderScope}
        decopilotId={decopilotId}
        orgPinnedIds={orgPinnedIds}
        onReorder={onReorder}
        renderGroup={renderGroup}
      />
      {showSeparator && <AgentGroupSectionSeparator />}
      <SortableAgentGroupSection
        section="user"
        groups={user}
        orderScope={orderScope}
        decopilotId={decopilotId}
        orgPinnedIds={orgPinnedIds}
        onReorder={onReorder}
        renderGroup={renderGroup}
      />
      {toolCallRuns && (
        <TaskGroup
          key={toolCallRuns.virtualMcpId}
          {...renderGroup(toolCallRuns)}
        />
      )}
    </>
  );
}
