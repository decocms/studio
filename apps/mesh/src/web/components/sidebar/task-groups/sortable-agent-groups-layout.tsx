import { DndContext, closestCenter } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  type SortableContextProps,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  partitionDisplayGroups,
  type SidebarGroupSection,
  type SidebarOrderScope,
} from "./stable-order";
import {
  useSortableAgentGroupOrder,
  type SortableAgentGroupSurface,
} from "./use-sortable-agent-group-order";
import { AgentGroupSectionSeparator } from "./agent-group-section-separator";
import type { TaskGroupData } from "./group-threads";

function SortableItemShell({
  id,
  children,
}: {
  id: string;
  children: (props: {
    setNodeRef: (node: HTMLElement | null) => void;
    style: CSSProperties;
    isDragging: boolean;
    attributes: ReturnType<typeof useSortable>["attributes"];
    listeners: ReturnType<typeof useSortable>["listeners"];
  }) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 100 : undefined,
  };

  return (
    <>
      {children({
        setNodeRef,
        style,
        isDragging,
        attributes,
        listeners,
      })}
    </>
  );
}

function SortableAgentGroupSection<TProps extends { virtualMcpId: string }>({
  section,
  groups,
  orderScope,
  decopilotId,
  orgPinnedIds,
  onReorder,
  surface,
  renderGroup,
  renderSortable,
  renderFixed,
}: {
  section: SidebarGroupSection;
  groups: TaskGroupData[];
  orderScope: SidebarOrderScope;
  decopilotId: string;
  orgPinnedIds: string[];
  onReorder: () => void;
  surface: SortableAgentGroupSurface;
  renderGroup: (group: TaskGroupData) => TProps;
  renderSortable: (
    props: TProps,
    sortable: {
      attributes: ReturnType<typeof useSortable>["attributes"];
      listeners: ReturnType<typeof useSortable>["listeners"];
      isDragging: boolean;
    },
  ) => ReactNode;
  renderFixed: (props: TProps) => ReactNode;
}) {
  const { sensors, sortableIds, handleDragEnd } = useSortableAgentGroupOrder(
    groups,
    section,
    orderScope,
    decopilotId,
    orgPinnedIds,
    onReorder,
    surface,
  );

  if (groups.length === 0) return null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={sortableIds as SortableContextProps["items"]}
        strategy={verticalListSortingStrategy}
      >
        {groups.map((group) => {
          const props = renderGroup(group);
          if (sortableIds.includes(group.virtualMcpId)) {
            return (
              <SortableItemShell
                key={group.virtualMcpId}
                id={group.virtualMcpId}
              >
                {({ setNodeRef, style, isDragging, attributes, listeners }) => (
                  <div
                    ref={setNodeRef}
                    style={style}
                    className={cn(isDragging && "opacity-50")}
                  >
                    {renderSortable(props, {
                      attributes,
                      listeners,
                      isDragging,
                    })}
                  </div>
                )}
              </SortableItemShell>
            );
          }
          return <div key={group.virtualMcpId}>{renderFixed(props)}</div>;
        })}
      </SortableContext>
    </DndContext>
  );
}

export function AgentGroupsSortableLayout<
  TProps extends { virtualMcpId: string },
>({
  groups,
  orderScope,
  decopilotId,
  orgPinnedIds,
  onReorder,
  surface,
  collapsedSeparator,
  renderGroup,
  renderSortable,
  renderFixed,
}: {
  groups: TaskGroupData[];
  orderScope: SidebarOrderScope;
  decopilotId: string;
  orgPinnedIds: string[];
  onReorder: () => void;
  surface: SortableAgentGroupSurface;
  collapsedSeparator?: boolean;
  renderGroup: (group: TaskGroupData) => TProps;
  renderSortable: (
    props: TProps,
    sortable: {
      attributes: ReturnType<typeof useSortable>["attributes"];
      listeners: ReturnType<typeof useSortable>["listeners"];
      isDragging: boolean;
    },
  ) => ReactNode;
  renderFixed: (props: TProps) => ReactNode;
}) {
  const { decopilot, orgPinned, user, toolCallRuns } = partitionDisplayGroups(
    groups,
    decopilotId,
    orgPinnedIds,
  );
  const showSeparator = orgPinned.length > 0 && user.length > 0;

  const sectionProps = {
    orderScope,
    decopilotId,
    orgPinnedIds,
    onReorder,
    surface,
    renderGroup,
    renderSortable,
    renderFixed,
  };

  return (
    <>
      {decopilot && renderFixed(renderGroup(decopilot))}
      <SortableAgentGroupSection
        section="org"
        groups={orgPinned}
        {...sectionProps}
      />
      {showSeparator && (
        <AgentGroupSectionSeparator collapsed={collapsedSeparator} />
      )}
      <SortableAgentGroupSection
        section="user"
        groups={user}
        {...sectionProps}
      />
      {toolCallRuns && renderFixed(renderGroup(toolCallRuns))}
    </>
  );
}
