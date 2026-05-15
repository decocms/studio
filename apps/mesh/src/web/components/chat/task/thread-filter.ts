import type { Task } from "./types";

export interface ThreadFilter {
  /** Keep only threads where `created_by === ownerUserId`. */
  ownerUserId?: string;
  /** Keep only threads whose `fromAutomation` matches this flag. */
  hasTrigger?: boolean;
  /** Keep only threads for a specific agent. */
  virtualMcpId?: string;
}

export function filterThreads(
  threads: readonly Task[],
  filter: ThreadFilter,
): Task[] {
  return threads.filter((thread) => {
    if (
      filter.ownerUserId !== undefined &&
      thread.created_by !== filter.ownerUserId
    )
      return false;
    if (
      filter.hasTrigger !== undefined &&
      Boolean(thread.fromAutomation) !== filter.hasTrigger
    )
      return false;
    if (
      filter.virtualMcpId !== undefined &&
      thread.virtual_mcp_id !== filter.virtualMcpId
    )
      return false;
    return true;
  });
}
