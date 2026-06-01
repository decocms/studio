import { ChevronDown, ChevronRight, Menu02, Plus } from "@untitledui/icons";
import type { DraggableAttributes } from "@dnd-kit/core";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { AgentAvatar } from "@/web/components/agent-icon";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@deco/ui/components/context-menu.tsx";
import { AgentGroupContextMenuItems } from "./agent-group-context-menu-items";
import { TaskRow } from "@/web/layouts/tasks-panel/task-row";
import {
  TOOL_CALL_RUNS_GROUP_KEY,
  type StatusGroupData,
} from "./group-threads";
import { useGroupExpanded } from "./use-group-expanded";
import type { Task } from "@/web/components/chat/task/types";
import { STATUS_CONFIG } from "@/web/lib/task-status";
import { ShowMoreButton } from "./show-more-button";
import type { SidebarFilters } from "./next-page-offset";
import { useGroupShowMore } from "./use-group-show-more";

export interface TaskGroupProps {
  virtualMcpId: string;
  threads: Task[];
  activeTaskId: string | null;
  onSelectTask: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  onNewTaskInGroup: (virtualMcpId: string) => void;
  onShowSettings: (virtualMcpId: string) => void;
  onHideGroup: (virtualMcpId: string) => void;
  isOrgPinned?: boolean;
  canManageOrgPin?: boolean;
  onToggleOrgPin?: (virtualMcpId: string, pinned: boolean) => void;
  /** When true, the group renders dimmed (used when filters wipe out the body). */
  dimmed: boolean;
  filters: SidebarFilters;
  /** When set, shows a drag handle for reordering agent groups. */
  sortableHandle?: {
    attributes: DraggableAttributes;
    listeners: SyntheticListenerMap | undefined;
  };
  isDragging?: boolean;
}

export function TaskGroup({
  virtualMcpId,
  threads,
  activeTaskId,
  onSelectTask,
  onArchiveTask,
  onNewTaskInGroup,
  onShowSettings,
  onHideGroup,
  isOrgPinned = false,
  canManageOrgPin = false,
  onToggleOrgPin,
  dimmed,
  filters,
  sortableHandle,
  isDragging,
}: TaskGroupProps) {
  const [expanded, setExpanded] = useGroupExpanded(virtualMcpId, false);
  const isToolCallRuns = virtualMcpId === TOOL_CALL_RUNS_GROUP_KEY;
  const showMore = useGroupShowMore("agent", virtualMcpId, filters);

  function handleToggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    if (
      next &&
      !isToolCallRuns &&
      threads.length === 0 &&
      showMore.hasMore &&
      !showMore.isFetching
    ) {
      void showMore.loadMore();
    }
  }

  const header = (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={handleToggleExpanded}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleToggleExpanded();
        }
      }}
      className={cn(
        "group/group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium text-foreground",
        "cursor-pointer hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 transition-colors",
        isDragging && "shadow-md bg-accent/40",
      )}
    >
      {sortableHandle && !isToolCallRuns && (
        <button
          type="button"
          {...sortableHandle.attributes}
          {...sortableHandle.listeners}
          aria-label="Drag to reorder agent group"
          className={cn(
            "shrink-0 text-muted-foreground hover:text-foreground touch-none",
            isDragging
              ? "cursor-grabbing"
              : "cursor-pointer active:cursor-grabbing",
            "opacity-0 group-hover/group:opacity-100 focus-visible:opacity-100",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <Menu02 size={14} />
        </button>
      )}
      <div className="relative size-5 shrink-0 flex items-center justify-center">
        <span className="absolute inset-0 flex items-center justify-center transition-opacity group-hover/group:opacity-0">
          <TaskGroupAvatar
            virtualMcpId={virtualMcpId}
            isToolCallRuns={isToolCallRuns}
          />
        </span>
        <span className="absolute inset-0 flex items-center justify-center text-muted-foreground opacity-0 transition-opacity group-hover/group:opacity-100">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </div>
      <span className="flex-1 truncate">
        <TaskGroupLabel
          virtualMcpId={virtualMcpId}
          isToolCallRuns={isToolCallRuns}
        />
      </span>
      {!isToolCallRuns && !dimmed && (
        <button
          type="button"
          aria-label="New task in this agent"
          onClick={(e) => {
            e.stopPropagation();
            onNewTaskInGroup(virtualMcpId);
          }}
          className="opacity-0 group-hover/group:opacity-100 focus-visible:opacity-100 transition-opacity flex size-7 items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Plus size={14} />
        </button>
      )}
    </div>
  );

  return (
    <div className={cn("flex flex-col gap-0.5", dimmed && "opacity-50")}>
      {isToolCallRuns ? (
        header
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
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
      )}
      {expanded && (
        <div className="flex flex-col gap-0.5 pb-1 pl-4">
          {isToolCallRuns ? (
            threads.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                isActive={activeTaskId === task.id}
                onClick={() => onSelectTask(task)}
                onArchive={() => onArchiveTask(task)}
                showAutomationBadge={Boolean(task.trigger_id)}
              />
            ))
          ) : (
            <AgentExpandedBody
              virtualMcpId={virtualMcpId}
              threads={threads}
              activeTaskId={activeTaskId}
              onSelectTask={onSelectTask}
              onArchiveTask={onArchiveTask}
              onNewTaskInGroup={onNewTaskInGroup}
              showMore={showMore}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TaskGroupAvatar({
  virtualMcpId,
  isToolCallRuns,
}: {
  virtualMcpId: string;
  isToolCallRuns: boolean;
}) {
  if (isToolCallRuns) {
    return <AgentAvatar icon={null} name="⚙" size="2xs" />;
  }
  return <TaskGroupAvatarInner virtualMcpId={virtualMcpId} />;
}

function TaskGroupAvatarInner({ virtualMcpId }: { virtualMcpId: string }) {
  const entity = useVirtualMCP(virtualMcpId);
  if (!entity) return <AgentAvatar icon={null} name="?" size="2xs" />;
  return (
    <AgentAvatar icon={entity.icon ?? null} name={entity.title} size="2xs" />
  );
}

function TaskGroupLabel({
  virtualMcpId,
  isToolCallRuns,
}: {
  virtualMcpId: string;
  isToolCallRuns: boolean;
}) {
  if (isToolCallRuns) return <>Automation runs</>;
  return <TaskGroupLabelInner virtualMcpId={virtualMcpId} />;
}

function TaskGroupLabelInner({ virtualMcpId }: { virtualMcpId: string }) {
  const entity = useVirtualMCP(virtualMcpId);
  return <>{entity?.title ?? "Agent"}</>;
}

function AgentExpandedBody({
  virtualMcpId,
  threads,
  activeTaskId,
  onSelectTask,
  onArchiveTask,
  onNewTaskInGroup,
  showMore,
}: {
  virtualMcpId: string;
  threads: Task[];
  activeTaskId: string | null;
  onSelectTask: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  onNewTaskInGroup: (virtualMcpId: string) => void;
  showMore: ReturnType<typeof useGroupShowMore>;
}) {
  const { isFetching, loadMore, hasMore } = showMore;

  return (
    <>
      {threads.length === 0 ? (
        <button
          type="button"
          onClick={() => onNewTaskInGroup(virtualMcpId)}
          className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 transition-colors"
        >
          <Plus size={14} />
          <span>New thread</span>
        </button>
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
          {(hasMore || isFetching) && (
            <ShowMoreButton
              onClick={() => void loadMore()}
              isFetching={isFetching}
            />
          )}
        </>
      )}
    </>
  );
}

function StatusExpandedBody({
  threads,
  activeTaskId,
  onSelectTask,
  onArchiveTask,
  showMore,
}: {
  threads: Task[];
  activeTaskId: string | null;
  onSelectTask: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  showMore: ReturnType<typeof useGroupShowMore>;
}) {
  const { isFetching, loadMore, hasMore } = showMore;

  return (
    <>
      {threads.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          isActive={activeTaskId === task.id}
          onClick={() => onSelectTask(task)}
          onArchive={() => onArchiveTask(task)}
          showAutomationBadge={Boolean(task.trigger_id)}
          showAgentIcon
          hideStatusIdle
        />
      ))}
      {(hasMore || isFetching) && (
        <ShowMoreButton
          onClick={() => void loadMore()}
          isFetching={isFetching}
        />
      )}
    </>
  );
}

export function StatusGroup({
  status,
  threads,
  activeTaskId,
  onSelectTask,
  onArchiveTask,
  filters,
}: {
  status: StatusGroupData["status"];
  threads: Task[];
  activeTaskId: string | null;
  onSelectTask: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  filters: SidebarFilters;
}) {
  const config = STATUS_CONFIG[status];
  const StatusIcon = config.icon;
  const [expanded, setExpanded] = useGroupExpanded(`status-${status}`, false);
  const showMore = useGroupShowMore("status", status, filters);

  function handleToggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    if (
      next &&
      threads.length === 0 &&
      showMore.hasMore &&
      !showMore.isFetching
    ) {
      void showMore.loadMore();
    }
  }

  return (
    <div className="flex flex-col gap-0.5">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={handleToggleExpanded}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleToggleExpanded();
          }
        }}
        className="group/group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium text-foreground cursor-pointer hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 transition-colors"
      >
        <div className="relative size-5 shrink-0 flex items-center justify-center">
          <span className="absolute inset-0 flex items-center justify-center transition-opacity group-hover/group:opacity-0">
            <StatusIcon size={12} className={config.iconClassName} />
          </span>
          <span className="absolute inset-0 flex items-center justify-center text-muted-foreground opacity-0 transition-opacity group-hover/group:opacity-100">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </div>
        <span className="flex-1 truncate">{config.label}</span>
        <div className="size-5 shrink-0 flex items-center justify-center">
          <span className="text-xs text-muted-foreground tabular-nums">
            {threads.length}
          </span>
        </div>
      </div>
      {expanded && (
        <div className="flex flex-col gap-0.5 pb-1 pl-4">
          <StatusExpandedBody
            threads={threads}
            activeTaskId={activeTaskId}
            onSelectTask={onSelectTask}
            onArchiveTask={onArchiveTask}
            showMore={showMore}
          />
        </div>
      )}
    </div>
  );
}
