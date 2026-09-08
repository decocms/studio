import type { Task } from "@/components/chat/task/types";
import { threadRuntimeMatches } from "@/lib/thread-runtime-match";
import type { ThreadRuntime } from "@decocms/shared/thread/session-runtime";

/**
 * Current user's most-recently-updated non-archived thread for `agentId`
 * (optionally runtime-matched), or null — the last *real* thread, empty or not.
 *
 * `onlyBranches`: keep only threads whose `branch` is in the set (legacy resume).
 * `excludeBranch`: skip threads on that branch (drafts-mode passes production).
 */
export function findLastThreadForAgent(
  threads: Task[],
  agentId: string,
  userId: string | undefined,
  expectedRuntime?: ThreadRuntime,
  onlyBranches?: ReadonlySet<string>,
  excludeBranch?: string | null,
): Task | null {
  let best: Task | null = null;
  for (const t of threads) {
    if (t.virtual_mcp_id !== agentId) continue;
    if (t.created_by !== userId) continue;
    if (t.hidden) continue;
    if (!threadRuntimeMatches(t, expectedRuntime)) continue;
    if (onlyBranches && (!t.branch || !onlyBranches.has(t.branch))) continue;
    if (excludeBranch && t.branch === excludeBranch) continue;
    if (!best || t.updated_at > best.updated_at) best = t;
  }
  return best;
}
