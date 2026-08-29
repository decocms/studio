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
 * This is the missing reconcile: if the linked PRs have all landed, move the
 * card forward (Merged with the delivery lanes on, else Done) and record the
 * transition. It runs from the review sweeper (see
 * `review-sweeper.ts`), which already visits exactly these cards on their own
 * five-minute interval and already knows each PR's live merged state.
 */

import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import { shippedLane } from "@decocms/shared/task-board";
import { recordTaskActivity } from "./activity";
import { cardWorkLanded, type PrLanding } from "./archive-merged";
import { boardFor } from "./board-handler";
import { inReviewPhase } from "./lanes";
import { emitTaskBoardUpdated } from "./run-reactions";

/**
 * Move `item` past review if its work landed on GitHub — to Merged with the
 * delivery lanes on, else to Done. See {@link cardWorkLanded} for what "landed"
 * means once a card carries more than one PR. Returns whether it moved.
 *
 * Takes the live PR states rather than reading GitHub itself: its one caller,
 * the sweeper, already reads every linked PR through the rate-limited queue
 * (`readPrStateThrottled`), and both `state` and `merged` come back on that
 * same `get`. Reading again here would put the sweep's real network call
 * OUTSIDE the queue that exists to keep it from exhausting the shared
 * `github-mcp` budget — see `dbos-github-read.ts`.
 *
 * Deliberately NOT gated on `auto_merge`, on who merged, or on the reviewers'
 * verdicts: the PR is already in the base branch, so the work shipped and the
 * card is simply out of date. The one thing it does honor is
 * `hasHumanRejectedDone` — a person who pulled this card back out of Done meant
 * it, and a merged PR is not a reason to overrule them.
 *
 * An unreadable PR is never read as landed, so a bad fetch defers to the next
 * sweep rather than shipping a card on a guess.
 */
export async function advanceToDoneIfMerged(
  ctx: StudioContext,
  item: TaskBoardItem,
  prs: PrLanding[],
): Promise<boolean> {
  const orgId = item.organizationId;
  if (!inReviewPhase(item)) return false;
  if (!cardWorkLanded(prs)) return false;
  if (await ctx.storage.taskBoard.hasHumanRejectedDone(item.id, orgId)) {
    return false;
  }

  // Read only once the card is actually shipping.
  const settings = await ctx.storage.organizationSettings.get(orgId);
  const shipped = shippedLane(settings?.flags);
  const board = await boardFor(ctx, orgId);
  const done = await ctx.storage.taskBoard.update(
    item.id,
    orgId,
    // Guarded like a manual move: this can file the card under an org's own column too.
    { status: shipped, boardColumnOrg: board.columnOwner() },
    item.updatedBy,
  );
  await recordTaskActivity(ctx, {
    taskBoardItemId: item.id,
    action: "status_changed",
    actorId: null,
    data: { from: item.status, to: shipped, reason: "pr_merged" },
  });
  emitTaskBoardUpdated(orgId, done);
  console.log(
    `[task-board-review-sweeper] ${item.id}: linked PR already merged — moved to ${shipped}`,
  );
  return true;
}
