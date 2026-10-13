/**
 * Advance a card under review whose PR already landed — no matter who merged it.
 *
 * A PR merged by a person on GitHub, or by GitHub's own auto-merge after
 * branch protection went green, moves no card on its own: Studio only moves a
 * card for a merge it performed (`shipFromReadyForDeployment`). Without this
 * the card sat In Review forever with nothing looking at it.
 *
 * The hourly `archive-merged`/`tag-merged` sweeps are not that safety net —
 * both gate on shipped lanes already, so they never see these cards.
 *
 * This is the missing reconcile: if the linked PRs have all landed, move the
 * card to Post-deploy Validation and record the transition. It runs from the
 * review sweeper (see `review-sweeper.ts`), which already visits exactly these
 * cards on their own five-minute interval and already knows each PR's live
 * merged state.
 */

import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import { LANES } from "@decocms/shared/task-board";
import { recordTaskActivity } from "./activity";
import { cardWorkLanded, type PrLanding } from "./archive-merged";
import { inReviewPhase } from "./lanes";
import { emitTaskBoardUpdated } from "./run-reactions";

/**
 * Move `item` to Post-deploy Validation if its work landed on GitHub. See {@link cardWorkLanded} for what "landed"
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
export async function shipIfMerged(
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

  const shipped = LANES.shipped;
  const done = await ctx.storage.taskBoard.update(
    item.id,
    orgId,
    { status: shipped },
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
