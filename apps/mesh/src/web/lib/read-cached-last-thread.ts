import type { QueryClient } from "@tanstack/react-query";
import { KEYS } from "./query-keys";
import type { Task, TasksQueryData } from "@/web/components/chat/task/types";

/**
 * Find the user's most recently updated thread with a given agent by
 * scanning the local TanStack Query cache. Used by the sidebar pinned-agent
 * click handler to resume the last conversation instead of always creating
 * a new thread. Returns null when no matching, non-archived thread is in
 * cache — callers should fall back to creating a new thread in that case.
 */
export function readCachedLastThread(
  queryClient: QueryClient,
  locator: string,
  virtualMcpId: string,
  userId: string,
): Task | null {
  const queries = queryClient.getQueriesData<TasksQueryData>({
    queryKey: KEYS.tasksPrefix(locator),
  });
  let best: Task | null = null;
  for (const [, data] of queries) {
    if (!data?.items) continue;
    for (const t of data.items) {
      if (t.virtual_mcp_id !== virtualMcpId) continue;
      if (t.created_by !== userId) continue;
      if (t.hidden) continue;
      if (!best || t.updated_at > best.updated_at) best = t;
    }
  }
  return best;
}
