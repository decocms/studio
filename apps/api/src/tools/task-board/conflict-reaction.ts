import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import {
  allReviewersApproved,
  enabledReviewerKinds,
  type ReviewCycleActivity,
  SUPER_AGENT_ASSIGNEE_ID,
} from "@decocms/shared/task-board";
import { recordTaskActivity } from "./activity";
import { emitTaskBoardUpdated, parkOnRunsExhausted } from "./run-reactions";
import { enqueueSuperAgentForTask } from "./enqueue-super-agent";

/**
 * How many times a single task may be auto-handed-back to the Super Agent to
 * resolve a merge conflict, all-time. A bound, not a target: if the agent keeps
 * failing to resolve (or the base branch keeps moving under it), stop the
 * automatic churn and leave the PR for a human rather than re-dispatching a run
 * every poll. Generous — a task rarely conflicts more than once.
 */
const MAX_AUTO_CONFLICT_RESOLUTIONS = 3;

/** True once a task has hit its all-time cap of auto conflict-resolution
 *  dispatches — counted from the `merge_conflict_resolution` activity entries,
 *  which persist across review cycles (so the cap doesn't reset when the task
 *  bounces back to In Review). Pure, so the off-by-one is unit-tested. */
export function conflictResolutionCapReached(
  activity: ReviewCycleActivity[],
): boolean {
  const attempts = activity.filter(
    (a) => a.action === "merge_conflict_resolution",
  ).length;
  return attempts >= MAX_AUTO_CONFLICT_RESOLUTIONS;
}

/**
 * When a task's PR is approved by every enabled reviewer but can't merge because
 * it conflicts with its base branch, hand it back to the Super Agent to resolve
 * the conflict — the automatic version of what a human would otherwise do
 * (check out the branch, merge the base, push). Reuses the same machinery as a
 * reviewer's change request: bounce the task to In Progress and re-enqueue the
 * Super Agent on the EXISTING PR, so when it finishes the task returns to In
 * Review, reviewers re-run on the merged result, and (with auto-merge on) it
 * ships. Keeping it In Review instead would fight `reopenTasksOnThreadRun`,
 * which pulls a task back to In Progress the moment a run starts on it.
 *
 * Gated on the org's `auto_merge` flag — conflict resolution is an extension of
 * auto-merge (the only thing standing between an approved PR and an automatic
 * merge is the conflict), so it rides the same opt-in rather than its own knob.
 * Also gated on the SAME verified all-approved check the auto-merge uses (a
 * self-asserted approval must not trigger it) and a per-task cap so a conflict
 * the agent can't resolve doesn't loop forever.
 *
 * `opts.pr` is the PR the caller detected the conflict on — the reaction acts on
 * THAT PR, not a re-derived "newest linked PR", so a task with more than one
 * linked PR (e.g. a closed one plus the open conflicting one) resolves the right
 * branch. `opts.conflict` is the mergeability signal: pass the already-known
 * value from the poll's live-state fetch to avoid a second GitHub round-trip;
 * the caller is responsible for it being an explicit `true` (a null/unknown must
 * never act).
 *
 * Returns true when it bounced the task and enqueued a resolution run (and has
 * already emitted the update). Best-effort at the seams; the caller wraps it.
 */
export async function reactToApprovedPrConflict(
  ctx: StudioContext,
  orgId: string,
  item: TaskBoardItem,
  opts: { pr: { number: number; url: string }; conflict: boolean | null },
): Promise<boolean> {
  // Only an In Review task delegated to the Super Agent is a candidate — a
  // human-owned review never gets an automatic run, and a task already moved on
  // (In Progress, Done) must not be bounced.
  if (item.status !== "in_review") return false;
  if (item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID) return false;
  if (opts.conflict !== true) return false;

  const settings = await ctx.storage.organizationSettings.get(orgId);
  const flags = settings?.flags ?? {};
  if (flags.auto_merge !== true) return false;

  // Same gate as the auto-merge: EVERY enabled reviewer must have a
  // token-verified approval in the current cycle. With no reviewer enabled
  // `allReviewersApproved` is false, so a conflict never auto-resolves without
  // an approval standing behind it.
  const enabled = enabledReviewerKinds(flags);
  const activity = await ctx.storage.taskBoard.listActivity(item.id, orgId);
  if (!allReviewersApproved(activity, enabled, { verifiedOnly: true })) {
    return false;
  }

  // Cap the automatic churn — a conflict the agent can't resolve mustn't loop.
  if (conflictResolutionCapReached(activity)) {
    console.warn(
      `[task-board] conflict auto-resolve cap (${MAX_AUTO_CONFLICT_RESOLUTIONS}) reached on task ${item.id} — leaving the PR for a human`,
    );
    return false;
  }

  const pr = opts.pr;

  // Atomically bounce to In Progress — this is the dispatch fence. If it returns
  // null we lost the race to a coinciding trigger (approval + poll), so skip:
  // the winner already enqueued the resolution run. Everything past here runs
  // for the single winner only, so the activity log (which feeds the cap count)
  // stays accurate. No `status_changed` entry — mirrors the request_changes
  // bounce; the review cycle resets only when the run advances back to In Review.
  const claimed = await ctx.storage.taskBoard.claimConflictResolution(
    item.id,
    orgId,
    item.updatedBy,
  );
  if (!claimed) return false;
  emitTaskBoardUpdated(orgId, claimed);
  try {
    await enqueueSuperAgentForTask(ctx, claimed, {
      pr: { number: pr.number, url: pr.url },
      resolveConflict: true,
    });
  } catch (err) {
    // The per-task run cap refused it: no run is coming, so say so on the card
    // instead of leaving it to be retried every poll until the conflict cap
    // (which now counts only real dispatches) papers over it.
    await parkOnRunsExhausted(ctx, claimed, err).catch(() => false);
    // Nothing was dispatched. Unlike a fresh delegation, this bounced the
    // task's STATUS to In Progress as the dispatch fence — leaving it there
    // strands the task forever: the guard above only fires on `in_review`,
    // so no future poll or approval retries it. Bounce back so it does.
    await ctx.storage.taskBoard
      .update(claimed.id, orgId, { status: "in_review" }, "system")
      .then((reverted) => emitTaskBoardUpdated(orgId, reverted))
      .catch((revertErr) =>
        console.error(
          "[task-board] conflict-resolution status revert failed",
          revertErr,
        ),
      );
    throw err;
  }
  // AFTER the dispatch, not before: this entry is what the cap counts, so
  // recording it up front let a dispatch that THREW spend a slot. In prod three
  // `runs_exhausted` throws burned the all-time cap of 3 in fifty-one seconds
  // without a single resolution run ever being created, and the PR was then
  // "left for a human" who had no way to see why. Undercounting a dispatch that
  // really started (if this write fails) is the safe direction: the cap is a
  // bound on churn, and one extra attempt beats abandoning a mergeable PR.
  await recordTaskActivity(ctx, {
    taskBoardItemId: item.id,
    action: "merge_conflict_resolution",
    actorId: null,
    data: { prNumber: pr.number },
  });
  return true;
}
