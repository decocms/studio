import type { Task } from "@/components/chat/task/types";
import { findLastThreadForAgent } from "@/lib/find-last-thread-for-agent";
import { threadRuntimeMatches } from "@/lib/thread-runtime-match";
import type { ThreadRuntime } from "@decocms/shared/thread/session-runtime";

/**
 * The current user's existing empty "New chat" thread for this agent, or
 * undefined if they have none.
 *
 * `"New chat"` is the marker of a never-auto-titled thread — a thread gets
 * titled once it completes a *successful* turn. We do NOT gate on `status`
 * (a fresh empty thread can carry any/no status, and gating on `in_progress`
 * is what let duplicate empty chats pile up when the same agent was
 * re-selected). But title alone is too loose: a thread whose first message
 * FAILED keeps the "New chat" title forever, so we'd reuse a dead,
 * non-empty, runtime-locked thread — stranding the user on a broken
 * conversation. `harness_id` is pinned on the first message, so `!harness_id`
 * means the thread is genuinely empty. That excludes failed/in-flight threads
 * while still reusing real empty chats. `created_by` scopes the match to the
 * current user — the thread list is org-wide (it includes teammates' threads
 * for the activity view), so without this we'd reuse a teammate's empty "New
 * chat" and strand the user on a read-only thread that isn't theirs. Every
 * entry point that navigates to an agent (the breadcrumb picker, the org-home
 * resolver, the repo switcher, …) reuses this so re-selecting an agent focuses
 * its empty chat instead of minting another.
 */
export function findReusableNewChat(
  threads: Task[],
  agentId: string,
  userId: string | undefined,
  expectedRuntime?: ThreadRuntime,
): Task | undefined {
  return threads.find(
    (t) =>
      !t.hidden &&
      t.virtual_mcp_id === agentId &&
      t.created_by === userId &&
      t.title === "New chat" &&
      !t.harness_id &&
      threadRuntimeMatches(t, expectedRuntime),
  );
}

/** Thread to land on when *entering* an agent: a `hasBranch` agent resumes its last real thread (last branch worked on); else reuse the empty chat, then `undefined` (caller mints a fresh id). */
export function findAgentEntryThread(
  threads: Task[],
  agentId: string,
  userId: string | undefined,
  expectedRuntime: ThreadRuntime | undefined,
  hasBranch: boolean,
): Task | undefined {
  if (hasBranch) {
    return (
      findLastThreadForAgent(threads, agentId, userId, expectedRuntime) ??
      findReusableNewChat(threads, agentId, userId, expectedRuntime)
    );
  }
  return findReusableNewChat(threads, agentId, userId, expectedRuntime);
}
