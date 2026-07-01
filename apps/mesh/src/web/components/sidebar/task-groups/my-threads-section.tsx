import { TaskRow } from "@/web/layouts/tasks-panel/task-row";
import type { Task } from "@/web/components/chat/task/types";
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
}) {
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
          onArchive={() => onArchiveTask(task)}
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
