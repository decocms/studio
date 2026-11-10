import type { Task } from "@/components/chat/task/types";
import { findLastThreadForAgent } from "@/lib/find-last-thread-for-agent";
import { threadRuntimeMatches } from "@/lib/thread-runtime-match";
import type { ThreadRuntime } from "@decocms/shared/thread/session-runtime";
import type { Release } from "@decocms/shared/sdk/types";

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

export interface AgentEntryOpts {
  /** Production branch, excluded from drafts resume so entry never lands there. */
  baseBranch?: string;
  /** The project's drafts, to skip a CMS thread left on a `sandbox` draft. */
  releases?: readonly Pick<Release, "branch" | "runtime">[];
}

/**
 * Thread to land on when *entering* an agent.
 *
 * With a branch (repo agent): resume the last draft, never `baseBranch` (production), else `undefined` — the caller mints a fresh draft.
 * A CMS entry skips drafts stamped `sandbox`: Fast Preview renders production's
 * code, so it would hide the branch's code. The version list opens those in a
 * coding chat.
 * Branchless: resume the last thread (empty or not), never piling up empty chats.
 */
export function findAgentEntryThread(
  threads: Task[],
  agentId: string,
  userId: string | undefined,
  expectedRuntime: ThreadRuntime | undefined,
  hasBranch: boolean,
  opts?: AgentEntryOpts,
): Task | undefined {
  if (!hasBranch) {
    return (
      findLastThreadForAgent(threads, agentId, userId, expectedRuntime) ??
      undefined
    );
  }
  const codeDrafts =
    expectedRuntime === "cms"
      ? new Set(
          (opts?.releases ?? [])
            .filter((r) => r.runtime === "sandbox")
            .map((r) => r.branch),
        )
      : null;
  const candidates = codeDrafts?.size
    ? threads.filter((t) => !t.branch || !codeDrafts.has(t.branch))
    : threads;
  return (
    findLastThreadForAgent(
      candidates,
      agentId,
      userId,
      expectedRuntime,
      opts?.baseBranch,
    ) ?? undefined
  );
}
