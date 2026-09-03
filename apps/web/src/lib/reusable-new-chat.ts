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

export interface AgentEntryOpts {
  /** Production ∪ named-release branches — the versions a thread can resume to. */
  knownBranches?: ReadonlySet<string>;
  /** Drafts mode never resumes an unnamed draft: a named version or production, else nothing (caller mints a fresh production thread). */
  draftsMode?: boolean;
}

/**
 * Thread to land on when *entering* an agent.
 *
 * A `hasBranch` agent's thread branch is only a *named version* (a release or
 * production) if it was promoted — a fresh thread mints an unnamed auto-generated
 * branch the drafts picker can only render as a "Rascunho". So we first prefer
 * the last thread on one of `knownBranches`, restoring the version the user was
 * editing.
 *
 * In `draftsMode` an unnamed draft is never editable: if no thread sits on a
 * named version we return `undefined` so the caller mints a fresh thread on
 * production. Otherwise (legacy branch/PR mode) we fall back to the raw last
 * thread, then the empty chat, then `undefined`.
 *
 * A branchless agent resumes its last thread (empty or not), never piling up empty chats.
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
  const known = opts?.knownBranches;
  const onNamedVersion =
    known && known.size > 0
      ? (findLastThreadForAgent(
          threads,
          agentId,
          userId,
          expectedRuntime,
          known,
        ) ?? undefined)
      : undefined;
  if (opts?.draftsMode) return onNamedVersion;
  return (
    onNamedVersion ??
    findLastThreadForAgent(threads, agentId, userId, expectedRuntime) ??
    findReusableNewChat(threads, agentId, userId, expectedRuntime)
  );
}
