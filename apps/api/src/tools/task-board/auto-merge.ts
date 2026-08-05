import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import { recordTaskActivity } from "./activity";
import { emitTaskBoardUpdated } from "./run-reactions";
import { mergeLinkedPr } from "./merge-pr";
import { fetchPrConflict } from "./prs-get";
import { reactToApprovedPrConflict } from "./conflict-reaction";

/** What `finalizeAutoMerge` did with the task's PR. `merged` → the PR merged and
 *  the task advanced to Done; `resolving` → the merge was blocked by a base-branch
 *  conflict and the PR was handed back to the Super Agent to resolve. Both false
 *  means nothing changed (auto-merge off, CI not ready, no PR, or a transient
 *  failure) and the task stays In Review. */
export type AutoMergeOutcome = { merged: boolean; resolving: boolean };

/**
 * The tail of the auto-merge flow, shared by the two ways an approved PR reaches
 * it: the reviewer decision (every enabled reviewer approved) and the
 * no-reviewer path (auto-merge on with QA Agent + Code Reviewer both off, driven
 * from `enqueueEnabledReviewers`). Callers must have already checked the
 * auto-merge gate is satisfied and the org's `auto_merge` flag is on — this
 * function just executes the merge.
 *
 * Tries to merge the task's open PR (`mergeLinkedPr` itself refuses to ship on
 * red/pending CI). On success it moves the task to Done, logs the status change,
 * and broadcasts the update. If the merge was blocked by a conflict with the
 * base branch specifically, it hands the PR back to the Super Agent to resolve
 * (the conflict fetch is a GitHub round-trip, so only pay it when a merge was
 * actually attempted). Returns what happened so the caller can report status.
 *
 * Emits on the terminal transitions it owns (Done, or the conflict bounce via
 * `reactToApprovedPrConflict`) but NOT on the no-op case — a caller that changed
 * other state (e.g. recorded an approval) is responsible for its own emit.
 */
export async function finalizeAutoMerge(
  ctx: StudioContext,
  orgId: string,
  task: TaskBoardItem,
): Promise<AutoMergeOutcome> {
  const merged = await mergeLinkedPr(ctx, orgId, task.id);
  if (merged) {
    const done = await ctx.storage.taskBoard.update(
      task.id,
      orgId,
      { status: "done" },
      task.updatedBy,
    );
    await recordTaskActivity(ctx, {
      taskBoardItemId: task.id,
      action: "status_changed",
      actorId: null,
      data: { from: task.status, to: "done" },
    });
    emitTaskBoardUpdated(orgId, done);
    return { merged: true, resolving: false };
  }

  // No merge — when it was a base-branch conflict, hand the PR back to the Super
  // Agent to resolve. Act on the newest linked PR (the one `mergeLinkedPr` just
  // tried). Best-effort: a dispatch failure must never surface as a merge error.
  const prs = await ctx.storage.taskBoard.listPrs(task.id, orgId);
  const pr = prs[0];
  const resolving = pr
    ? await reactToApprovedPrConflict(ctx, orgId, task, {
        pr: { number: pr.number, url: pr.url },
        conflict: await fetchPrConflict(ctx, orgId, pr),
      }).catch((err) => {
        console.error("[task-board] conflict auto-resolve failed", err);
        return false;
      })
    : false;
  return { merged: false, resolving };
}
