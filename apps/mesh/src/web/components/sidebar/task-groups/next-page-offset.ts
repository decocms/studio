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

export interface ShowMoreArgs {
  where: Record<string, unknown>;
  limit: number;
  offset: number;
  orderBy: Array<{ field: string[]; direction: "asc" | "desc" }>;
  status?: string;
}

/**
 * Build the arguments for a per-group `COLLECTION_THREADS_LIST` call.
 *
 * The thread list tool schema puts `virtual_mcp_id` / `created_by` /
 * `has_trigger` inside `where`, but `status` lives at the top level of the
 * arguments. This helper places each field where the server expects it,
 * so the hook can stay focused on state management.
 */
export function buildShowMoreArgs(
  kind: GroupKind,
  groupKey: string,
  offset: number,
  filters: SidebarFilters,
  limit: number,
): ShowMoreArgs {
  const where: Record<string, unknown> = {};
  if (kind === "agent") where.virtual_mcp_id = groupKey;
  if (filters.member === "mine" && filters.currentUserId) {
    where.created_by = filters.currentUserId;
  }
  if (filters.type === "automation") where.has_trigger = true;
  if (filters.type === "manual") where.has_trigger = false;

  const args: ShowMoreArgs = {
    where,
    limit,
    offset,
    orderBy: [{ field: ["updated_at"], direction: "desc" }],
  };
  if (kind === "status") args.status = groupKey;
  return args;
}

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
