import { ChevronDown, ChevronRight, Code02, Plus } from "@untitledui/icons";
import { useState } from "react";
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
  /** Precomputed visible count for this group (avoids O(T) scan per hook). */
  groupVisibleCount?: number;
  /** When this live group is paired with a dev agent, the dev agent's id. Its
   *  threads (carried in `threads`, keyed by this id) render in a "Develop"
   *  sub-section instead of a standalone sidebar group. */
  devPartnerId?: string | null;
  /** Precomputed visible count for the dev partner's threads. */
  devGroupVisibleCount?: number;
  filters: SidebarFilters;
  /** When set, the group header is draggable for reordering. */
  sortable?: {
    attributes: DraggableAttributes;
    listeners: SyntheticListenerMap | undefined;
    isDragging: boolean;
  };
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
  filters,
  groupVisibleCount,
  devPartnerId = null,
  devGroupVisibleCount,
  sortable,
}: TaskGroupProps) {
  const [expanded, setExpanded] = useGroupExpanded(virtualMcpId, false);
  const isToolCallRuns = virtualMcpId === TOOL_CALL_RUNS_GROUP_KEY;
  const isDragging = sortable?.isDragging ?? false;

  // Threads carry both the live agent's and (folded-in) dev agent's threads,
  // keyed by virtual_mcp_id. Split so the dev ones render in a "Develop"
  // sub-section with their own pagination (keyed by the dev agent id).
  const devThreads = devPartnerId
    ? threads.filter((t) => t.virtual_mcp_id === devPartnerId)
    : [];
  const liveThreads = devPartnerId
    ? threads.filter((t) => t.virtual_mcp_id !== devPartnerId)
    : threads;
  const showDevSection =
    !!devPartnerId &&
    (devThreads.length > 0 || (devGroupVisibleCount ?? 0) > 0);

  function handleToggleExpanded() {
    const next = !expanded;
    setExpanded(next);
  }

  const header = (
    <div
      {...(sortable && !isToolCallRuns
        ? { ...sortable.attributes, ...sortable.listeners }
        : {})}
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
        sortable && !isToolCallRuns && "touch-none active:cursor-grabbing",
        isDragging && "shadow-md bg-accent/40 cursor-grabbing",
      )}
    >
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
      {!isToolCallRuns && (
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
    <div className="flex flex-col gap-0.5">
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
                indented
              />
            ))
          ) : (
            <>
              <AgentExpandedBody
                virtualMcpId={virtualMcpId}
                threads={liveThreads}
                activeTaskId={activeTaskId}
                onSelectTask={onSelectTask}
                onArchiveTask={onArchiveTask}
                onNewTaskInGroup={onNewTaskInGroup}
                filters={filters}
                groupVisibleCount={groupVisibleCount}
              />
              {showDevSection && devPartnerId && (
                <div className="flex flex-col gap-0.5 mt-1.5">
                  <div className="flex items-center gap-1.5 px-2 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">
                    <Code02 size={11} />
                    Develop
                  </div>
                  <AgentExpandedBody
                    virtualMcpId={devPartnerId}
                    threads={devThreads}
                    activeTaskId={activeTaskId}
                    onSelectTask={onSelectTask}
                    onArchiveTask={onArchiveTask}
                    onNewTaskInGroup={onNewTaskInGroup}
                    filters={filters}
                    groupVisibleCount={devGroupVisibleCount}
                  />
                </div>
              )}
            </>
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
  filters,
  groupVisibleCount,
}: {
  virtualMcpId: string;
  threads: Task[];
  activeTaskId: string | null;
  onSelectTask: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  onNewTaskInGroup: (virtualMcpId: string) => void;
  filters: SidebarFilters;
  groupVisibleCount?: number;
}) {
  const showMore = useGroupShowMore(
    "agent",
    virtualMcpId,
    filters,
    groupVisibleCount,
  );
  const { isFetching, isProbing, loadMore, serverHasMore } = showMore;

  const [autoLoaded, setAutoLoaded] = useState(false);
  if (
    !autoLoaded &&
    threads.length === 0 &&
    serverHasMore === true &&
    !isFetching &&
    !isProbing
  ) {
    setAutoLoaded(true);
    queueMicrotask(() => {
      void loadMore();
    });
  }
  const { hasMore } = showMore;

  return (
    <>
      {threads.length === 0 ? (
        <button
          type="button"
          onClick={() => onNewTaskInGroup(virtualMcpId)}
          // -ml-4 cancels the group wrapper's pl-4 so the hover surface spans
          // the full sidebar width, while pl-6 keeps the content indented —
          // matching the indented TaskRow treatment.
          className="flex items-center gap-2 -ml-4 pl-6 pr-2 py-1.5 rounded-md cursor-pointer text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 transition-colors"
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
              indented
            />
          ))}
          {(hasMore || isFetching) && (
            <ShowMoreButton
              onClick={() => void loadMore()}
              isFetching={isFetching}
              indented
            />
          )}
        </>
      )}
    </>
  );
}

function StatusExpandedBody({
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
  const { isFetching, isProbing, loadMore, hasMore, serverHasMore } =
    useGroupShowMore("status", status, filters);

  const [autoLoaded, setAutoLoaded] = useState(false);
  if (
    !autoLoaded &&
    threads.length === 0 &&
    serverHasMore === true &&
    !isFetching &&
    !isProbing
  ) {
    setAutoLoaded(true);
    queueMicrotask(() => {
      void loadMore();
    });
  }

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
          indented
        />
      ))}
      {(hasMore || isFetching) && (
        <ShowMoreButton
          onClick={() => void loadMore()}
          isFetching={isFetching}
          indented
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

  function handleToggleExpanded() {
    setExpanded(!expanded);
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
            status={status}
            threads={threads}
            activeTaskId={activeTaskId}
            onSelectTask={onSelectTask}
            onArchiveTask={onArchiveTask}
            filters={filters}
          />
        </div>
      )}
    </div>
  );
}
