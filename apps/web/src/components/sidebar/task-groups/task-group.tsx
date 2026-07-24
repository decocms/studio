import { ChevronDown, ChevronRight } from "@untitledui/icons";
import { useState } from "react";
import { TaskRow } from "@/layouts/tasks-panel/task-row";
import type { StatusGroupData } from "./group-threads";
import { useGroupExpanded } from "./use-group-expanded";
import type { Task } from "@/components/chat/task/types";
import { STATUS_CONFIG } from "@/lib/task-status";
import { ShowMoreButton } from "./show-more-button";
import type { SidebarFilters } from "./next-page-offset";
import { useGroupShowMore } from "./use-group-show-more";

function StatusExpandedBody({
  status,
  threads,
  activeTaskId,
  onSelectTask,
  onArchiveTask,
  canArchive,
  filters,
}: {
  status: StatusGroupData["status"];
  threads: Task[];
  activeTaskId: string | null;
  onSelectTask: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  canArchive: boolean;
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
          onArchive={
            canArchive && task.created_by === filters.currentUserId
              ? () => onArchiveTask(task)
              : undefined
          }
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
  canArchive,
  filters,
}: {
  status: StatusGroupData["status"];
  threads: Task[];
  activeTaskId: string | null;
  onSelectTask: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  canArchive: boolean;
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
            canArchive={canArchive}
            filters={filters}
          />
        </div>
      )}
    </div>
  );
}
