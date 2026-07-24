import type { Task } from "@/components/chat/task/types";

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
/**
 * `branch` is optional. Pass it (including `null` for a branchless thread) from
 * a "New chat on the branch I'm viewing" action to only reuse an empty chat on
 * that same branch — reusing one on a different branch would silently switch the
 * user's branch. OMIT it (`undefined`) for "open agent X" flows, which have no
 * current branch to inherit and should reuse the agent's empty chat regardless.
 */
export function findReusableNewChat(
  threads: Task[],
  agentId: string,
  userId: string | undefined,
  branch?: string | null,
): Task | undefined {
  return threads.find(
    (t) =>
      !t.hidden &&
      t.virtual_mcp_id === agentId &&
      t.created_by === userId &&
      t.title === "New chat" &&
      !t.harness_id &&
      (branch === undefined || (t.branch ?? null) === branch),
  );
}
