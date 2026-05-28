import type { Task } from "@/web/components/chat/task/types";
import type { StatusKey } from "@/web/lib/task-status";

export type SidebarTypeFilter = "all" | "manual" | "automation";
export type SidebarMemberFilter = "all" | "mine";

export interface SidebarFilters {
  type: SidebarTypeFilter;
  member: SidebarMemberFilter;
  currentUserId: string | null;
}

export type GroupKind = "agent" | "status";

/**
 * Number of tasks currently loaded in the flat list that match the given
 * group and the active sidebar filters. This is the offset to pass to the
 * next per-group `COLLECTION_THREADS_LIST` call so the server skips rows
 * already known to the client.
 */
export function nextPageOffset(
  threads: Task[],
  kind: GroupKind,
  groupKey: string,
  filters: SidebarFilters,
): number {
  let count = 0;
  for (const thread of threads) {
    if (thread.hidden) continue;
    if (kind === "agent" && thread.virtual_mcp_id !== groupKey) continue;
    if (
      kind === "status" &&
      (thread.status ?? "completed") !== (groupKey as StatusKey)
    )
      continue;
    if (
      filters.member === "mine" &&
      filters.currentUserId &&
      thread.created_by !== filters.currentUserId
    ) {
      continue;
    }
    if (filters.type === "automation" && !thread.trigger_id) continue;
    if (filters.type === "manual" && thread.trigger_id) continue;
    count++;
  }
  return count;
}
