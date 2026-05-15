import type { QueryClient } from "@tanstack/react-query";
import { KEYS } from "./query-keys";
import type { TasksQueryData } from "@/web/components/chat/task/types";

/**
 * Read a task's branch out of the React Query cache without firing a fetch.
 * Used by "+ New task" entry points outside the chat context (tasks-panel,
 * agent-shell-layout toolbar) to carry the active task's branch into the
 * COLLECTION_THREADS_CREATE call so the new thread lands on the same warm
 * sandbox.
 *
 * Returns null when the task isn't in any cached list, or when the cached
 * row's branch is missing.
 */
export function readCachedTaskBranch(
  queryClient: QueryClient,
  locator: string,
  taskId: string,
): string | null {
  if (!taskId) return null;
  const queries = queryClient.getQueriesData<TasksQueryData>({
    queryKey: KEYS.tasksPrefix(locator),
  });
  for (const [, data] of queries) {
    const task = data?.items?.find((t) => t.id === taskId);
    if (task?.branch) return task.branch;
  }
  return null;
}
