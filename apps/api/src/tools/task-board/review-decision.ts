import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import {
  REVIEWER_LABEL,
  type ReviewCycleActivity,
  reviewCycleStart,
  reviewCycleVerdicts,
  type ReviewerKind,
} from "@decocms/shared/task-board";
import { TaskBoardItemStatusSchema } from "./schema";
import { recordTaskActivity } from "./activity";

import {
  emitTaskBoardUpdated,
  handTaskToHuman,
  moveApprovedCardToQa,
} from "./run-reactions";
import { allEnabledReviewersVerifiedApproved } from "./merge-pr";
import { verifyReviewToken } from "./review-token";
import { ensureReviewerCommented } from "./reviewer-comment";
import { taskRunContextStore } from "./task-run-context";

/** `notes` is mirrored verbatim into a card comment (`ensureReviewerCommented`),
 *  same cap as a regular comment body so a reviewer can't grow one without
 *  bound. */
const MAX_REVIEW_NOTES_LENGTH = 50_000;

/**
 * True when a resolved LEGACY reviewToken claim actually belongs to THIS
 * reviewer's claim on the CURRENT review cycle. (Current tokens are HMACs —
 * see `review-token.ts`; this only serves runs dispatched before that deploy.)
 *
 * The claims table held a fresh row (and token) per review cycle but never
 * deleted the old one, so comparing only the reviewer field — as this
 * used to — let a token minted for an EARLIER cycle still verify: a reviewer
 * that kept its token from a prior bounce (visible in that run's own prompt,
 * see `enqueueReviewerForTask`) could replay it after being bounced back and
 * re-approving with no real review this cycle, counting toward the
 * two-reviewer auto-merge gate the token exists to protect. Comparing
 * `cycleAt` closes that: a claim from any cycle but the current one no longer
 * verifies. Pure — unit-tested.
 */
export function reviewTokenVerified(
  claim: { reviewer: string; cycleAt: Date } | null,
  reviewer: string,
  currentCycleAt: number,
): boolean {
  return (
    claim !== null &&
    claim.reviewer === reviewer &&
    claim.cycleAt.getTime() === currentCycleAt
  );
}

/**
 * True when this reviewer already requested changes in the current review
 * cycle — the call is a repeat, not a second verdict. Pure — unit-tested.
 *
 * Reviewer runs do call twice: an agent that gets a tool result it doesn't
 * recognise as terminal calls again, and one QA run landed the same notes twice
 * ten seconds apart on six cards in one night. The first call already handed the
 * card over, so the repeat would only re-record a verdict already answered.
 *
 * Scoped to the CYCLE, so a genuine second opinion after a human re-delegates is
 * a fresh verdict, not a duplicate. Only `request_changes`: it is the decision
 * with a side effect, and a repeated approval is inert — while dropping one
 * could discard the verified retry of an approval whose first call lost its
 * token.
 */
export function isDuplicateChangeRequest(
  history: ReviewCycleActivity[],
  reviewer: ReviewerKind,
  cycleStartedAt: string | null,
): boolean {
  return (
    reviewCycleVerdicts(history, { cycleStartedAt }).get(reviewer) ===
    "changes_requested"
  );
}

export const TASK_BOARD_REVIEW_DECISION = defineTool({
  name: "TASK_BOARD_REVIEW_DECISION",
  description:
    "Record a reviewer's decision for a task under review. `approve` marks the " +
    "pull request approved by that reviewer and, once EVERY enabled reviewer " +
    "has approved, moves the task to QA, where a person checks it; " +
    "`request_changes` records your notes and hands the task to a person — " +
    "review is single-pass, so it is not sent back to the Super Agent.",
  annotations: {
    title: "Review Decision",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    taskBoardItemId: z.string(),
    reviewer: z
      // ponytail: `qa` / `code_review` are the two-reviewer era's names, kept
      // ONLY so a reviewer run dispatched before this deploy can still record
      // its verdict — rejected input there means a card stuck In Review with a
      // verdict nobody kept. Normalized to `reviewer` below. Drop both once no
      // in-flight cycle predates the deploy.
      .enum(["reviewer", "qa", "code_review"])
      .describe("Which reviewer you are — pass `reviewer`."),
    reviewToken: z
      .string()
      .optional()
      .describe(
        "The reviewToken from your prompt — proves you are this reviewer. " +
          "Pass it through exactly; an approval without a valid token is " +
          "recorded but does NOT move the task on.",
      ),
    decision: z.enum(["approve", "request_changes"]),
    notes: z
      .string()
      .min(1)
      .max(MAX_REVIEW_NOTES_LENGTH)
      .describe(
        "For approve: a short summary of what you verified. For " +
          "request_changes: specific, actionable feedback the Super Agent " +
          "must address.",
      ),
  }),
  outputSchema: z.object({
    status: TaskBoardItemStatusSchema,
  }),
  handler: async (
    {
      taskBoardItemId,
      reviewer: claimedReviewer,
      reviewToken,
      decision,
      notes,
    },
    ctx,
  ) => {
    // One reviewer now; a legacy claim is that same reviewer under its old name.
    // The token is verified against the name it was MINTED with (below), not
    // this one.
    const reviewer: ReviewerKind = "reviewer";
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const item = await ctx.storage.taskBoard.getById(
      taskBoardItemId,
      organizationId,
    );
    if (!item) {
      throw new Error(`Task board item not found: ${taskBoardItemId}`);
    }

    // Verify the caller is the reviewer it claims to be, against THIS task's
    // CURRENT cycle: the reviewToken must be the HMAC over (task, reviewer,
    // cycle). An unverified decision is still recorded (so a dropped token
    // never stalls the flow) but won't move the card on (see the verified gate
    // below).
    //
    // ROLLOUT: runs dispatched before this deploy carry a random `rtok_<uuid>`
    // from `task_board_review_claims`, so fall back to the table lookup — also
    // cycle-scoped, or a token kept across a bounce re-approves with no review.
    // Delete that branch (and the table, its migration, and
    // `resolveReviewClaimByToken`) once every in-flight review cycle has
    // drained — a day is ample.
    const currentCycleAt = reviewToken
      ? reviewCycleStart(
          item.reviewCycleStartedAt
            ? []
            : await ctx.storage.taskBoard.listActivity(
                taskBoardItemId,
                organizationId,
              ),
          item.reviewCycleStartedAt,
        )
      : 0;
    const verified =
      !!reviewToken &&
      (verifyReviewToken(
        reviewToken,
        taskBoardItemId,
        claimedReviewer,
        new Date(currentCycleAt),
      ) ||
        reviewTokenVerified(
          await ctx.storage.taskBoard.resolveReviewClaimByToken(
            taskBoardItemId,
            reviewToken,
          ),
          claimedReviewer,
          currentCycleAt,
        ));

    // The reviewer's record on the card is not optional. A run that posted no
    // comment gets its verdict notes mirrored into one (free — see
    // `reviewer-comment.ts`); QA that showed no visual evidence gets one
    // follow-up turn on its own thread. Best-effort: neither may fail an
    // otherwise-good verdict, and the thread gate queues any follow-up run
    // behind this one either way.
    const runThreadId = taskRunContextStore.getStore()?.threadId;
    if (runThreadId) {
      await ensureReviewerCommented(ctx, item, reviewer, runThreadId, {
        decision,
        notes,
      }).catch((err) =>
        console.error("[task-board] reviewer comment record failed", err),
      );
    }

    if (decision === "request_changes") {
      // Review is SINGLE-PASS: a change-request ends the task's automated run.
      // It is NOT bounced back to the Super Agent — the reviewer applies its
      // own findings on the PR branch, so a `request_changes` verdict means
      // something it could not settle itself, and that is a person's call.
      // The verdict is still recorded (it is the reviewer's most useful output)
      // and the card stays In Review with the notes on it.
      const history = await ctx.storage.taskBoard.listActivity(
        taskBoardItemId,
        organizationId,
      );
      if (
        isDuplicateChangeRequest(history, reviewer, item.reviewCycleStartedAt)
      ) {
        return { status: item.status };
      }
      await recordTaskActivity(ctx, {
        taskBoardItemId,
        action: "review_changes_requested",
        actorId: null,
        data: { reviewer, notes, verified },
      });
      await handTaskToHuman(
        ctx,
        item,
        `${REVIEWER_LABEL[reviewer]} requested changes — review is single-pass`,
      );
      const handed =
        (await ctx.storage.taskBoard.getById(
          taskBoardItemId,
          organizationId,
        )) ?? item;
      return { status: handed.status };
    }

    // approve — record first so the all-approved check below sees this verdict.
    await recordTaskActivity(ctx, {
      taskBoardItemId,
      action: "review_approved",
      actorId: null,
      data: { reviewer, notes, verified },
    });

    // Only the LAST enabled reviewer to (verifiably) approve completes the
    // review. Until then the task waits In Review; an approval that never
    // verifies is handed to a person by the sweeper (`moveFinishedReviewToQa`).
    const complete = await allEnabledReviewersVerifiedApproved(
      ctx,
      organizationId,
      taskBoardItemId,
    );
    const moved = complete ? await moveApprovedCardToQa(ctx, item) : null;
    if (moved) return { status: moved.status };
    const refreshed =
      (await ctx.storage.taskBoard.getById(taskBoardItemId, organizationId)) ??
      item;
    emitTaskBoardUpdated(organizationId, refreshed);
    return { status: refreshed.status };
  },
});
