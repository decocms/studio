/**
 * Decision logic for "archiving the last chat on a branch reclaims its
 * worktree" (desktop only).
 *
 * A worktree's identity is `(repo, branch)` and `threads.branch` is N:1 onto
 * branch, so "no non-archived threads left on this branch" is exactly "this
 * worktree has no remaining owner". The reclaim is irreversible — the native
 * `remove_registered` primitive never refuses on a dirty or unpushed worktree —
 * so every rule that decides whether to prompt, and what happens on each
 * outcome, lives here as pure data and is unit-tested directly.
 */
import type { Task } from "@/components/chat/task/types";

/** The `(thread, agent, branch)` tuple a reclaim needs. */
export interface WorktreeReclaimTarget {
  taskId: string;
  virtualMcpId: string;
  branch: string;
}

/**
 * The reclaim target for a thread, or `null` when this archive can never
 * reclaim anything and must go straight through.
 *
 * `isDesktopApp` is passed in (rather than read here) so this stays pure: the
 * single gate is `isDesktopAppEnvironment()` at the call site. `virtual_mcp_id`
 * is required because `SANDBOX_DELETE` is addressed by `(virtualMcpId, branch)` —
 * a thread with a branch but no agent has no addressable sandbox.
 */
export function worktreeReclaimTarget(
  task: Pick<Task, "id" | "branch" | "virtual_mcp_id">,
  isDesktopApp: boolean,
): WorktreeReclaimTarget | null {
  if (!isDesktopApp) return null;
  const branch = task.branch?.trim();
  const virtualMcpId = task.virtual_mcp_id?.trim();
  if (!branch || !virtualMcpId) return null;
  return { taskId: task.id, virtualMcpId, branch };
}

/**
 * Whether another OPEN chat still uses this branch — i.e. whether a worktree
 * would still have an owner after this thread is archived.
 *
 * Answered entirely from the loaded feed, with no query behind it. That is only
 * sound because this runs on the desktop, where the local intercept returns the
 * thread list in full rather than a page (see `list()` in
 * `intercept::thread_tools`) and SSE keeps it current. So an empty result here
 * genuinely means "nobody else", not "nobody else on the page we happen to
 * hold" — the distinction the reclaim decision hangs on.
 *
 * `threads` must therefore be the unfiltered feed, never a view already
 * narrowed by the sidebar's scope or type filters.
 */
export function hasOpenSiblingOnBranch(
  threads: readonly Task[],
  target: WorktreeReclaimTarget,
): boolean {
  return threads.some(
    (thread) =>
      thread.id !== target.taskId &&
      !thread.hidden &&
      thread.branch === target.branch &&
      thread.virtual_mcp_id === target.virtualMcpId,
  );
}

/** Ordered side effects of the confirm dialog. */
export type ArchiveConfirmStep = "archive" | "reclaim-worktree";

const CONFIRM_STEPS: readonly ArchiveConfirmStep[] = [
  "archive",
  "reclaim-worktree",
];
const CANCEL_STEPS: readonly ArchiveConfirmStep[] = [];

/**
 * What the dialog's outcome performs, in order.
 *
 * Cancel performs NONE of the archive — not "archive anyway, skip the delete".
 * The dialog gates the archive itself, so the thread simply stays open.
 *
 * Confirm archives FIRST, then reclaims. A failed reclaim leaves an archived
 * thread and a live worktree — a leak, recoverable by hand. The reverse order
 * would leave a visible chat whose worktree is gone.
 */
export function archiveConfirmSteps(
  outcome: "cancel" | "confirm",
): readonly ArchiveConfirmStep[] {
  return outcome === "confirm" ? CONFIRM_STEPS : CANCEL_STEPS;
}
