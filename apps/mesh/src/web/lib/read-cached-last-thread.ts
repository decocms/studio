import { getManager } from "@/web/components/chat/store/thread-manager-store";
import type { Task } from "@/web/components/chat/task/types";

/**
 * Find the user's most recently updated thread with a given agent by scanning
 * the active `ThreadManagerStore`. Used by the sidebar pinned-agent click
 * handler to resume the last conversation instead of always creating a new
 * thread. Returns null when no manager is open for `(orgSlug, locator)` or
 * when no matching non-archived thread exists in the store — callers should
 * fall back to creating a new thread in that case.
 */
export function readCachedLastThread(
  orgSlug: string,
  locator: string,
  virtualMcpId: string,
  userId: string,
): Task | null {
  const manager = getManager(orgSlug, locator);
  if (!manager) return null;
  let best: Task | null = null;
  for (const t of manager.threads.get()) {
    if (t.virtual_mcp_id !== virtualMcpId) continue;
    if (t.created_by !== userId) continue;
    if (t.hidden) continue;
    if (!best || t.updated_at > best.updated_at) best = t;
  }
  return best;
}
