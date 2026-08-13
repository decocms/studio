import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import {
  MAX_REVIEW_BOUNCES,
  REVIEWER_LABEL,
  type ReviewCycleActivity,
  reviewBounceLimitReached,
  reviewCycleStart,
  reviewCycleVerdicts,
  type ReviewerKind,
} from "@decocms/shared/task-board";
import { TaskBoardItemStatusSchema } from "./schema";
import { recordTaskActivity } from "./activity";
import {
  emitTaskBoardUpdated,
  handTaskToHuman,
  parkOnRunsExhausted,
} from "./run-reactions";
import { enqueueSuperAgentForTask } from "./enqueue-super-agent";
import {
  allEnabledReviewersVerifiedApproved,
  conflictSignal,
  mergeLinkedPr,
} from "./merge-pr";
import { fetchPrConflict, pickActivePr } from "./prs-get";
import { verifyReviewToken } from "./review-token";
import { reactToApprovedPrConflict } from "./conflict-reaction";
import { TaskQuotaError } from "@/billing/task-quota";

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
 * ten seconds apart on six cards in one night. The first call already bounced
 * the card, so the repeat is *usually* absorbed by `claimReviewChangesBounce`
 * (the card has left In Review and the claim returns null) — but only usually:
 * if the re-run finished in between, the card is back In Review and the stale
 * repeat bounces it a second time, spending a run and a bounce on a verdict
 * already answered. It also charged the bounce budget a cycle early, which is
 * how four of these cards were handed over one round sooner than the cap says.
 *
 * Scoped to the CYCLE, so a genuine second opinion after the Super Agent pushes
 * a fix is a fresh verdict, not a duplicate. Only `request_changes`: it is the
 * decision with a side effect, and a repeated approval is inert — while
 * dropping one could discard the verified retry of an approval whose first call
 * lost its token.
 */
export function isDuplicateChangeRequest(
  history: ReviewCycleActivity[],
  reviewer: ReviewerKind,
): boolean {
  return reviewCycleVerdicts(history).get(reviewer) === "changes_requested";
}

export const TASK_BOARD_REVIEW_DECISION = defineTool({
  name: "TASK_BOARD_REVIEW_DECISION",
  description:
    "Record a reviewer's decision for a task under review. `approve` marks the " +
    "pull request approved by that reviewer (and, once EVERY enabled reviewer " +
    "has approved, merges it when the org enabled auto-merge, advancing the " +
    "task to Done); `request_changes` hands the task back to the Super Agent " +
    "with your notes so it can fix the PR.",
  annotations: {
    title: "Review Decision",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    // May merge a PR on GitHub.
    openWorldHint: true,
  },
  inputSchema: z.object({
    taskBoardItemId: z.string(),
    reviewer: z
      .enum(["qa", "code_review"])
      .describe(
        "Which reviewer you are: `qa` (QA Agent) or `code_review` (Code Reviewer).",
      ),
    reviewToken: z
      .string()
      .optional()
      .describe(
        "The reviewToken from your prompt — proves you are this reviewer. " +
          "Pass it through exactly; an approval without a valid token is " +
          "recorded but does NOT count toward an automatic merge.",
      ),
    decision: z.enum(["approve", "request_changes"]),
    notes: z
      .string()
      .min(1)
      .describe(
        "For approve: a short summary of what you verified. For " +
          "request_changes: specific, actionable feedback the Super Agent " +
          "must address.",
      ),
  }),
  outputSchema: z.object({
    status: TaskBoardItemStatusSchema,
    merged: z
      .boolean()
      .describe(
        "True when this approval completed the review and merged the PR.",
      ),
  }),
  handler: async (
    { taskBoardItemId, reviewer, reviewToken, decision, notes },
    ctx,
  ) => {
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
    // never stalls the flow) but won't count toward an automatic merge (see the
    // verified gate below).
    //
    // ROLLOUT: runs dispatched before this deploy carry a random `rtok_<uuid>`
    // from `task_board_review_claims`, so fall back to the table lookup — also
    // cycle-scoped, or a token kept across a bounce re-approves with no review.
    // Delete that branch (and the table, its migration, and
    // `resolveReviewClaimByToken`) once every in-flight review cycle has
    // drained — a day is ample.
    const currentCycleAt = reviewToken
      ? reviewCycleStart(
          await ctx.storage.taskBoard.listActivity(
            taskBoardItemId,
            organizationId,
          ),
        )
      : 0;
    const verified =
      !!reviewToken &&
      (verifyReviewToken(
        reviewToken,
        taskBoardItemId,
        reviewer,
        new Date(currentCycleAt),
      ) ||
        reviewTokenVerified(
          await ctx.storage.taskBoard.resolveReviewClaimByToken(
            taskBoardItemId,
            reviewToken,
          ),
          reviewer,
          currentCycleAt,
        ));

    if (decision === "request_changes") {
      // Break a runaway review loop BEFORE bouncing. A reviewer that keeps
      // finding something keeps finding something, and each round costs a
      // sandbox run — one board logged 179 change-requests against 68
      // approvals. Past the cap the verdict is still recorded (it is the
      // reviewer's most useful output) but the task stops going back to the
      // Super Agent and is handed to a person instead.
      //
      // Checked BEFORE `claimReviewChangesBounce`, not after: that call moves
      // the card to In Progress, and skipping the dispatch afterwards would
      // leave it sitting In Progress with nothing running — the
      // delegated-but-idle state this codebase goes out of its way to avoid.
      const history = await ctx.storage.taskBoard.listActivity(
        taskBoardItemId,
        organizationId,
      );
      if (isDuplicateChangeRequest(history, reviewer)) {
        return { status: item.status, merged: false };
      }
      if (reviewBounceLimitReached(history)) {
        await recordTaskActivity(ctx, {
          taskBoardItemId,
          action: "review_changes_requested",
          actorId: null,
          data: { reviewer, notes, verified, bounceLimitReached: true },
        });
        // Stays In Review with the reviewer's notes, where a human picks it up.
        await handTaskToHuman(
          ctx,
          item,
          `${MAX_REVIEW_BOUNCES} review bounces reached — the reviewer and the ` +
            `Super Agent are not converging`,
        );
        const handed =
          (await ctx.storage.taskBoard.getById(
            taskBoardItemId,
            organizationId,
          )) ?? item;
        return { status: handed.status, merged: false };
      }

      // Any reviewer requesting changes bounces the task straight back to the
      // Super Agent with the feedback in its re-run prompt — no need to wait on
      // the other reviewer. Pull it back to In Progress and re-enqueue directly.
      //
      // Atomically claim the bounce — the dispatch fence. QA and Code Reviewer
      // run concurrently, and either can independently decide changes are
      // needed; without this fence both would win a plain update and each
      // enqueue its own Super Agent run on the SAME PR, racing to push
      // conflicting commits. The claim also re-checks the assignee is still
      // the Super Agent, so a human who took the task over mid-review isn't
      // overridden by a reviewer run that started before the reassignment. The
      // decision is still recorded either way (see below) — only the losing
      // reviewer's re-enqueue is skipped, since either the first winner's run
      // already carries the fix forward, or the task has a new owner now.
      const updated = await ctx.storage.taskBoard.claimReviewChangesBounce(
        taskBoardItemId,
        organizationId,
        item.updatedBy,
      );
      await recordTaskActivity(ctx, {
        taskBoardItemId,
        action: "review_changes_requested",
        actorId: null,
        data: { reviewer, notes, verified },
      });
      if (!updated) {
        const current =
          (await ctx.storage.taskBoard.getById(
            taskBoardItemId,
            organizationId,
          )) ?? item;
        return { status: current.status, merged: false };
      }
      emitTaskBoardUpdated(organizationId, updated);
      // Pass the PR under review so the re-run updates it in place (checks out
      // its branch) instead of opening a second PR.
      const prs = await ctx.storage.taskBoard.listPrs(
        taskBoardItemId,
        organizationId,
      );
      const pr = await pickActivePr(ctx, organizationId, prs);
      // Best-effort, like the auto-merge conflict path below — a dispatch
      // failure (no model configured, queue error) must never fail this
      // decision: the bounce-to-in_progress + activity write already
      // committed, so surfacing an error here would report failure on an
      // otherwise-successful reviewer decision.
      await enqueueSuperAgentForTask(ctx, updated, {
        feedback: `${REVIEWER_LABEL[reviewer]}: ${notes}`,
        pr: pr ? { number: pr.number, url: pr.url } : undefined,
      }).catch(async (err) => {
        // The per-task run cap refused the re-dispatch. Nothing will run, and
        // the bounce above already moved the card to In Progress — so put it
        // back and hand it over, rather than rethrowing (which fails an
        // otherwise-good reviewer decision and strands the card In Progress
        // with nothing running).
        if (await parkOnRunsExhausted(ctx, updated, err)) {
          await ctx.storage.taskBoard
            .update(
              updated.id,
              organizationId,
              { status: "in_review" },
              "system",
            )
            .then((reverted) => emitTaskBoardUpdated(organizationId, reverted))
            .catch((revertErr) =>
              console.error(
                "[task-board] runs-exhausted status revert failed",
                revertErr,
              ),
            );
          return;
        }
        // Any other paywall rejection is NOT best-effort — swallowing it would
        // leave the task bounced-but-never-re-running with only a log line
        // (same reasoning as reactToSuperAgentDelegation).
        if (err instanceof TaskQuotaError) throw err;
        console.error("[task-board] request_changes re-enqueue failed", err);
      });
      return { status: updated.status, merged: false };
    }

    // approve — record first so the all-approved check below sees this verdict.
    await recordTaskActivity(ctx, {
      taskBoardItemId,
      action: "review_approved",
      actorId: null,
      data: { reviewer, notes, verified },
    });

    // Only the LAST enabled reviewer to (verifiably) approve completes the
    // review. Until then the task waits In Review for the other reviewer.
    const complete = await allEnabledReviewersVerifiedApproved(
      ctx,
      organizationId,
      taskBoardItemId,
    );
    if (!complete) {
      const refreshed =
        (await ctx.storage.taskBoard.getById(
          taskBoardItemId,
          organizationId,
        )) ?? item;
      emitTaskBoardUpdated(organizationId, refreshed);
      return { status: refreshed.status, merged: false };
    }

    const settings = await ctx.storage.organizationSettings.get(organizationId);
    const autoMerge = settings?.flags?.auto_merge === true;
    const outcome = autoMerge
      ? await mergeLinkedPr(ctx, organizationId, taskBoardItemId)
      : null;
    const merged = outcome?.merged === true;

    // A merge ships the task → Done.
    if (merged) {
      const done = await ctx.storage.taskBoard.update(
        taskBoardItemId,
        organizationId,
        { status: "done" },
        item.updatedBy,
      );
      await recordTaskActivity(ctx, {
        taskBoardItemId,
        action: "status_changed",
        actorId: null,
        data: { from: item.status, to: "done" },
      });
      emitTaskBoardUpdated(organizationId, done);
      return { status: done.status, merged: true };
    }

    // No merge — the task is still In Review (we only move it on a merge). When
    // auto-merge is on and the merge was blocked by a conflict specifically (not
    // pending CI, not a transient failure), hand the PR back to the Super Agent
    // to resolve it — the headless counterpart to the poll path in `prs-get`.
    // The conflict fetch is a GitHub round-trip, so only pay it when auto-merge
    // is on. Otherwise leave it In Review for a human.
    const current =
      (await ctx.storage.taskBoard.getById(taskBoardItemId, organizationId)) ??
      item;
    if (autoMerge) {
      const prs = await ctx.storage.taskBoard.listPrs(
        taskBoardItemId,
        organizationId,
      );
      // The same PR `mergeLinkedPr` just tried to merge — detect and act on it.
      const pr = await pickActivePr(ctx, organizationId, prs);
      // Best-effort, like the poll path in `prs-get` — a dispatch failure (no
      // model configured, queue error) must never fail this decision: the
      // approval + bounce-to-in_progress + activity write already committed,
      // so surfacing an error here would report failure on an otherwise-
      // successful reviewer decision while burning a conflict-resolution
      // attempt with no run enqueued.
      const resolving = pr
        ? await reactToApprovedPrConflict(ctx, organizationId, current, {
            pr: { number: pr.number, url: pr.url },
            conflict: conflictSignal(
              await fetchPrConflict(ctx, organizationId, pr),
              outcome,
            ),
          }).catch((err) => {
            // Same paywall exception as above — a TaskQuotaError must
            // surface, not be swallowed as a routine auto-resolve failure.
            if (err instanceof TaskQuotaError) throw err;
            console.error("[task-board] conflict auto-resolve failed", err);
            return false;
          })
        : false;
      if (resolving) {
        const bounced =
          (await ctx.storage.taskBoard.getById(
            taskBoardItemId,
            organizationId,
          )) ?? current;
        // `reactToApprovedPrConflict` already emitted the update.
        return { status: bounced.status, merged: false };
      }
    }
    emitTaskBoardUpdated(organizationId, current);
    return { status: current.status, merged: false };
  },
});
