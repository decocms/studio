import { Inbox01 } from "@untitledui/icons";
import { TaskRow } from "@/layouts/tasks-panel/task-row";
import type { Task } from "@/components/chat/task/types";
import { groupThreadsByDate, groupThreadsByStatus } from "./group-threads";
import { StatusGroup } from "./task-group";
import { ShowMoreButton } from "./show-more-button";
import type { SidebarFilters } from "./next-page-offset";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import type { DateBucket } from "./group-threads";

const DATE_BUCKET_LABEL_KEYS: Record<DateBucket, TranslationKey> = {
  today: "sidebar.myThreadsSection.today",
  yesterday: "sidebar.myThreadsSection.yesterday",
  week: "sidebar.myThreadsSection.previousWeek",
  month: "sidebar.myThreadsSection.previousMonth",
  older: "sidebar.myThreadsSection.older",
};

/**
 * The current user's threads, all agents mixed. Two renderings toggled by the
 * sidebar's group-by control:
 *  - "flat": a chronological list under date headings (Today, Yesterday, …).
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
  const t = useT();
  if (threads.length === 0 && !hasMore && !isFetchingMore) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center text-muted-foreground">
        <Inbox01 className="size-6 opacity-60" />
        <p className="text-sm">
          {filtersActive
            ? t("sidebar.myThreadsSection.noChatsMatchFilters")
            : t("sidebar.myThreadsSection.noChatsYet")}
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
      {groupThreadsByDate(threads, new Date()).map((group) => (
        <section key={group.bucket} className="flex flex-col gap-0.5">
          <h3 className="px-2.5 pt-3 pb-1 text-xs font-medium text-muted-foreground first:pt-1">
            {t(DATE_BUCKET_LABEL_KEYS[group.bucket])}
          </h3>
          {group.threads.map((task) => (
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
            />
          ))}
        </section>
      ))}
      {(hasMore || isFetchingMore) && (
        <ShowMoreButton onClick={onLoadMore} isFetching={isFetchingMore} />
      )}
    </>
  );
}
