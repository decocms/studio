/**
 * Advance an In Review card whose PR already landed — no matter who merged it.
 *
 * Every other route out of In Review is a side effect of Studio performing the
 * merge itself: `TASK_BOARD_REVIEW_DECISION` sets `done` only when it merged
 * inline, and `retryAutoMergeIfApproved` only retries a merge Studio attempted.
 * Both are gated on the org's `auto_merge` flag, so a PR merged by a person on
 * GitHub, by GitHub's own auto-merge after branch protection went green, or on
 * an org that never had `auto_merge` on, left the card parked In Review forever
 * with nothing looking at it.
 *
 * The hourly `archive-merged`/`tag-merged` sweeps are not that safety net —
 * both gate on `status === "done"` already, so they never see these cards.
 *
 * This is the missing reconcile: ask GitHub whether the linked PRs are merged
 * and, if they all are, move the card to Done and record the transition. It
 * runs from the review sweeper (see `review-sweeper.ts`), which already visits
 * exactly these cards on their own five-minute interval.
 */

import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem, TaskBoardItemPrRef } from "@/storage/types";
import { recordTaskActivity } from "./activity";
import { allPrsMerged } from "./archive-merged";
import { fetchPrMerged } from "./prs-get";
import { emitTaskBoardUpdated } from "./run-reactions";

/** How the reconcile asks GitHub whether a PR merged — a parameter only so a
 *  test can drive the path without a GitHub connection, same as the tag sweep. */
type PrMergedReader = (
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
) => Promise<boolean | null>;

/**
 * Move `item` to Done if every linked PR is merged on GitHub. Returns whether
 * it moved.
 *
 * Deliberately NOT gated on `auto_merge`, on who merged, or on the reviewers'
 * verdicts: the PR is already in the base branch, so the work shipped and the
 * card is simply out of date. The one thing it does honor is
 * `hasHumanRejectedDone` — a person who pulled this card back out of Done meant
 * it, and a merged PR is not a reason to overrule them.
 *
 * `null` from the reader (GitHub unreachable) is never read as merged, so a bad
 * fetch defers to the next sweep rather than shipping a card on a guess.
 */
export async function advanceToDoneIfMerged(
  ctx: StudioContext,
  item: TaskBoardItem,
  prs: TaskBoardItemPrRef[],
  prMerged: PrMergedReader = fetchPrMerged,
): Promise<boolean> {
  const orgId = item.organizationId;
  if (item.status !== "in_review") return false;
  if (prs.length === 0) return false;
  if (await ctx.storage.taskBoard.hasHumanRejectedDone(item.id, orgId)) {
    return false;
  }

  const merged = await Promise.all(prs.map((pr) => prMerged(ctx, orgId, pr)));
  if (!allPrsMerged(merged)) return false;

  const done = await ctx.storage.taskBoard.update(
    item.id,
    orgId,
    { status: "done" },
    item.updatedBy,
  );
  await recordTaskActivity(ctx, {
    taskBoardItemId: item.id,
    action: "status_changed",
    actorId: null,
    data: { from: item.status, to: "done", reason: "pr_merged" },
  });
  emitTaskBoardUpdated(orgId, done);
  console.log(
    `[task-board-review-sweeper] ${item.id}: linked PR already merged — moved to done`,
  );
  return true;
}
