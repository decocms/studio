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

/** Page size for per-group sidebar pagination (matches `useGroupShowMore`). */
export const GROUP_PAGE_SIZE = 10;

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
  const where: Record<string, unknown> = { hidden: false };
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

function nextPageOffsetFromThreads(
  threads: Task[],
  kind: GroupKind,
  groupKey: string,
  filters: SidebarFilters,
): number {
  let count = 0;
  for (const thread of threads) {
    if (threadMatchesSidebarGroup(thread, kind, groupKey, filters)) {
      count++;
    }
  }
  return count;
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
  return nextPageOffsetFromThreads(threads, kind, groupKey, filters);
}

/** Per-group visible thread counts for the active sidebar filters (single O(T) pass). */
export function buildGroupThreadCounts(
  threads: Task[],
  kind: GroupKind,
  filters: SidebarFilters,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    const groupKey =
      kind === "agent" ? thread.virtual_mcp_id : (thread.status ?? "completed");
    if (!groupKey) continue;
    if (!threadMatchesSidebarGroup(thread, kind, groupKey, filters)) continue;
    counts.set(groupKey, (counts.get(groupKey) ?? 0) + 1);
  }
  return counts;
}

/**
 * Optimistic hint before the server total is known. A lightweight probe
 * (`limit: 1`) replaces this as soon as the group body mounts.
 */
export function deriveGroupHasMore(
  visibleCount: number,
  globalHasMore: boolean,
): boolean {
  if (visibleCount >= GROUP_PAGE_SIZE) return true;
  if (visibleCount === 0 && globalHasMore) return true;
  return false;
}

/** Authoritative once `COLLECTION_THREADS_LIST` returns `totalCount`. */
export function groupHasMoreFromTotal(
  visibleCount: number,
  totalCount: number,
): boolean {
  return visibleCount < totalCount;
}

/** Combine derived pagination hint with per-group fetch result. */
export function resolveGroupHasMore(
  derivedHasMore: boolean,
  serverHasMore: boolean | null,
): boolean {
  if (serverHasMore === false) return false;
  if (serverHasMore === true) return true;
  return derivedHasMore;
}

export function threadMatchesSidebarGroup(
  thread: Task,
  kind: GroupKind,
  groupKey: string,
  filters: SidebarFilters,
): boolean {
  if (thread.hidden) return false;
  if (kind === "agent" && thread.virtual_mcp_id !== groupKey) return false;
  if (
    kind === "status" &&
    (thread.status ?? "completed") !== (groupKey as StatusKey)
  ) {
    return false;
  }
  if (
    filters.member === "mine" &&
    filters.currentUserId &&
    thread.created_by !== filters.currentUserId
  ) {
    return false;
  }
  if (filters.type === "automation" && !thread.trigger_id) return false;
  if (filters.type === "manual" && thread.trigger_id) return false;
  return true;
}
