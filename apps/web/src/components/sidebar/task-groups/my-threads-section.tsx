import { Inbox01 } from "@untitledui/icons";
import { TaskRow } from "@/layouts/tasks-panel/task-row";
import type { Task } from "@/components/chat/task/types";
import { groupThreadsByStatus } from "./group-threads";
import { StatusGroup } from "./task-group";
import { ShowMoreButton } from "./show-more-button";
import type { SidebarFilters } from "./next-page-offset";

/**
 * The current user's threads, all agents mixed. Two renderings toggled by the
 * sidebar's group-by control:
 *  - "flat": a single chronological list (each row shows its agent icon).
 *  - "status": collapsible groups by thread status.
 *
 * In flat mode, pagination piggybacks on the global thread store's
 * `fetchNextPage` (the same feed the Team section reads) via the Show more
 * button. Status mode keeps its existing per-status server pagination.
 */
export function MyThreadsSection({
  threads,
  groupBy,
  activeTaskId,
  onSelectTask,
  onArchiveTask,
  filters,
  hasMore,
  isFetchingMore,
  onLoadMore,
  filtersActive,
}: {
  threads: Task[];
  groupBy: "flat" | "status";
  activeTaskId: string | null;
  onSelectTask: (task: Task) => void;
  onArchiveTask: (task: Task) => void;
  filters: SidebarFilters;
  hasMore: boolean;
  isFetchingMore: boolean;
  onLoadMore: () => void;
  filtersActive?: boolean;
}) {
  if (threads.length === 0 && !hasMore && !isFetchingMore) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center text-muted-foreground">
        <Inbox01 className="size-6 opacity-60" />
        <p className="text-sm">
          {filtersActive ? "No chats match your filters" : "No chats yet"}
        </p>
      </div>
    );
  }

  // Archiving your only thread is pointless — the app immediately mints a fresh
  // "New chat" to replace it. Hide the archive affordance until there's more
  // than one thread (or more waiting on the next page).
  const canArchive = threads.length > 1 || hasMore;

  if (groupBy === "status") {
    return (
      <>
        {groupThreadsByStatus(threads).map((group) => (
          <StatusGroup
            key={group.status}
            status={group.status}
            threads={group.threads}
            activeTaskId={activeTaskId}
            onSelectTask={onSelectTask}
            onArchiveTask={onArchiveTask}
            canArchive={canArchive}
            filters={filters}
          />
        ))}
      </>
    );
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
        />
      ))}
      {(hasMore || isFetchingMore) && (
        <ShowMoreButton onClick={onLoadMore} isFetching={isFetchingMore} />
      )}
    </>
  );
}
