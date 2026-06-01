import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@deco/ui/components/hover-card.tsx";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { AgentAvatar } from "@/web/components/agent-icon";
import {
  SidebarMenuButton,
  SidebarMenuItem,
} from "@deco/ui/components/sidebar.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@deco/ui/components/context-menu.tsx";
import { Plus } from "@untitledui/icons";
import type { DraggableAttributes } from "@dnd-kit/core";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import { cn } from "@deco/ui/lib/utils.ts";
import { AgentGroupContextMenuItems } from "./agent-group-context-menu-items";
import { TaskRow } from "@/web/layouts/tasks-panel/task-row";
import { ShowMoreButton } from "./show-more-button";
import { useGroupShowMore } from "./use-group-show-more";
import type { SidebarFilters } from "./next-page-offset";
import { track } from "@/web/lib/posthog-client";
import type { Task } from "@/web/components/chat/task/types";

export interface CollapsedGroupPopoverProps {
  virtualMcpId: string;
  threads: Task[];
  activeTaskId: string | null;
  filters: SidebarFilters;
  onSelectTask: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  onNewTaskInGroup: (virtualMcpId: string) => void;
  onShowSettings: (virtualMcpId: string) => void;
  onHideGroup: (virtualMcpId: string) => void;
  isOrgPinned?: boolean;
  canManageOrgPin?: boolean;
  onToggleOrgPin?: (virtualMcpId: string, pinned: boolean) => void;
  sortable?: {
    attributes: DraggableAttributes;
    listeners: SyntheticListenerMap | undefined;
    isDragging: boolean;
  };
}

/**
 * In collapsed rail state, each VM group is represented by its avatar.
 * Hovering opens a popover preview that shows the same accordion body.
 *
 * `useGroupShowMore` lives in `CollapsedGroupPopoverBody` rather than here
 * so the hook (and its thread-store subscriptions) only mounts when the
 * HoverCard is open — not for every icon in the collapsed rail.
 */
export function CollapsedGroupPopover({
  virtualMcpId,
  threads,
  activeTaskId,
  filters,
  onSelectTask,
  onArchiveTask,
  onNewTaskInGroup,
  onShowSettings,
  onHideGroup,
  isOrgPinned = false,
  canManageOrgPin = false,
  onToggleOrgPin,
  sortable,
}: CollapsedGroupPopoverProps) {
  const entity = useVirtualMCP(virtualMcpId);
  const latestTask = threads[0];

  const handleClick = () => {
    if (latestTask) {
      onSelectTask(latestTask);
    } else {
      onNewTaskInGroup(virtualMcpId);
    }
  };

  return (
    <HoverCard
      open={sortable?.isDragging ? false : undefined}
      openDelay={120}
      closeDelay={150}
      onOpenChange={(next) => {
        if (sortable?.isDragging) return;
        if (next) {
          track("sidebar_group_hover_popover_opened", {
            virtual_mcp_id: virtualMcpId,
          });
        }
      }}
    >
      <ContextMenu>
        <SidebarMenuItem>
          <ContextMenuTrigger asChild>
            <HoverCardTrigger asChild>
              <SidebarMenuButton
                onClick={handleClick}
                isActive={Boolean(
                  latestTask && activeTaskId && latestTask.id === activeTaskId,
                )}
                title={sortable ? "Drag to reorder" : undefined}
                {...(sortable
                  ? {
                      ...sortable.attributes,
                      ...sortable.listeners,
                    }
                  : {})}
                className={cn(
                  "group-data-[state=collapsed]/sidebar:!size-10 group-data-[state=collapsed]/sidebar:!max-w-none group-data-[state=collapsed]/sidebar:!overflow-visible group-data-[state=collapsed]/sidebar:[&_svg]:opacity-100",
                  sortable &&
                    "cursor-pointer active:cursor-grabbing touch-none",
                  sortable?.isDragging && "cursor-grabbing",
                )}
              >
                <AgentAvatar
                  icon={entity?.icon ?? null}
                  name={entity?.title ?? "?"}
                  size="sm+"
                  className="rounded-lg"
                />
              </SidebarMenuButton>
            </HoverCardTrigger>
          </ContextMenuTrigger>
        </SidebarMenuItem>
        <ContextMenuContent className="w-56">
          <AgentGroupContextMenuItems
            virtualMcpId={virtualMcpId}
            isOrgPinned={isOrgPinned}
            canManageOrgPin={canManageOrgPin}
            onNewTaskInGroup={onNewTaskInGroup}
            onShowSettings={onShowSettings}
            onToggleOrgPin={onToggleOrgPin ?? (() => {})}
            onHideGroup={onHideGroup}
          />
        </ContextMenuContent>
      </ContextMenu>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-72 p-2"
      >
        <div className="flex items-center justify-between px-1 pb-1 text-xs font-medium">
          <span className="truncate">{entity?.title ?? "Agent"}</span>
          <button
            type="button"
            aria-label="New task in this agent"
            onClick={() => onNewTaskInGroup(virtualMcpId)}
            className="flex size-6 items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
          >
            <Plus size={14} />
          </button>
        </div>
        <CollapsedGroupPopoverBody
          virtualMcpId={virtualMcpId}
          threads={threads}
          activeTaskId={activeTaskId}
          filters={filters}
          onSelectTask={onSelectTask}
          onArchiveTask={onArchiveTask}
        />
      </HoverCardContent>
    </HoverCard>
  );
}

function CollapsedGroupPopoverBody({
  virtualMcpId,
  threads,
  activeTaskId,
  filters,
  onSelectTask,
  onArchiveTask,
}: {
  virtualMcpId: string;
  threads: Task[];
  activeTaskId: string | null;
  filters: SidebarFilters;
  onSelectTask: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
}) {
  const showMore = useGroupShowMore("agent", virtualMcpId, filters);
  return (
    <div className="flex flex-col gap-0.5 max-h-[60vh] overflow-y-auto">
      {threads.length === 0 && !showMore.hasMore && !showMore.isFetching ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          No tasks yet
        </div>
      ) : (
        <>
          {threads.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              isActive={activeTaskId === task.id}
              onClick={() => onSelectTask(task)}
              onArchive={() => onArchiveTask(task)}
              showAutomationBadge={Boolean(task.trigger_id)}
            />
          ))}
          {(showMore.hasMore || showMore.isFetching) && (
            <ShowMoreButton
              onClick={() => void showMore.loadMore()}
              isFetching={showMore.isFetching}
            />
          )}
        </>
      )}
    </div>
  );
}
