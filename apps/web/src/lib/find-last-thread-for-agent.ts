import type { Task } from "@/components/chat/task/types";

/**
 * The current user's most-recently-updated non-archived thread with `agentId`,
 * or null when they have none. Scans an already-loaded thread list (the
 * ThreadManager's org-wide "Mine" page, ordered `updated_at` desc) — used by
 * the sidebar agent rows to resume the last conversation instead of always
 * landing on an empty composer.
 *
 * `created_by === userId` scopes the match to the current user — the list is
 * org-wide (it carries teammates' threads for the activity view), so without it
 * we'd resume a teammate's read-only thread. `!hidden` skips archived threads.
 * Returns null when nothing matches, so callers fall back to the empty-composer
 * behavior. Unlike `findReusableNewChat` this intentionally does NOT gate on
 * `title`/`harness_id`: we want the last *real* conversation, empty or not.
 */
export function findLastThreadForAgent(
  threads: Task[],
  agentId: string,
  userId: string | undefined,
): Task | null {
  let best: Task | null = null;
  for (const t of threads) {
    if (t.virtual_mcp_id !== agentId) continue;
    if (t.created_by !== userId) continue;
    if (t.hidden) continue;
    if (!best || t.updated_at > best.updated_at) best = t;
  }
  return best;
}
