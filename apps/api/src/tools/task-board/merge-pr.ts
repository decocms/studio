import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import {
  changeRequestClientForOrigin,
  type MergeOutcome as ProviderMergeOutcome,
} from "@/git-providers";
import {
  allReviewersApproved,
  approvedButUnverified,
  enabledReviewerKinds,
  LANES,
} from "@decocms/shared/task-board";
import { recordTaskActivity } from "./activity";
import { reactToApprovedPrConflict } from "./conflict-reaction";
import { originOf } from "./change-request-extract";
import {
  type ChecksStatus,
  fetchPrChecksStatus,
  invalidatePrCards,
  invalidatePrReads,
  pickActivePr,
  readNamespace,
} from "./prs-get";
import { inReviewPhase } from "./lanes";
import {
  emitTaskBoardUpdated,
  handTaskToHuman,
  moveApprovedCardToQa,
} from "./run-reactions";

/**
 * Why a merge didn't happen. `checks_pending` is the one ROUTINE outcome — CI
 * is still running and the next attempt will simply succeed — so it is the one
 * reason that never reaches the card's timeline. Everything else means a human
 * has to do something, and until now they had no way to know.
 *
 * `conflict` is split out from `refused` because it is the one refusal with an
 * automatic answer: the Super Agent can rebase. Every other refusal (branch
 * protection, a required review) needs a person.
 */
export type MergeFailureReason =
  | "no_pr"
  | "checks_pending"
  | "checks_failing"
  | "no_connection"
  | "rate_limited"
  | "conflict"
  | "refused"
  | "error";

export type MergeOutcome =
  | { merged: true }
  | { merged: false; reason: MergeFailureReason; detail?: string };

/** Reasons worth a timeline entry — see {@link MergeFailureReason}. */
const SILENT_REASONS = new Set<MergeFailureReason>(["checks_pending"]);

/**
 * Whether a PR's CI state should stop the merge. Pure — unit-tested.
 *
 * Red CI (`failing`) blocks every caller, always. In-flight CI (`pending`)
 * blocks the automatic paths (auto-merge, a stale client), but a human clicking
 * "Ship to production" passes `allowPendingChecks` to override it — they decided
 * the pending run isn't worth waiting for. An unknown state (`null`) never
 * blocks: we can't prove it's bad, and GitHub branch protection is the real gate.
 */
export function checksBlockMerge(
  checks: ChecksStatus,
  opts: { allowPendingChecks?: boolean } = {},
): boolean {
  if (checks === "failing") return true;
  if (checks === "pending") return !opts.allowPendingChecks;
  return false;
}

/**
 * Append a `merge_failed` entry, unless the task's newest entry is already a
 * `merge_failed` for the same reason.
 *
 * The dedup is load-bearing, not cosmetic: the sweeper retries a stranded card
 * every 60s, so an un-deduped write would add 1,440 identical rows a day to
 * every card whose repo lost its GitHub connection — burying the timeline it
 * exists to make readable. Keying on the NEWEST entry (not "any entry") is what
 * keeps a genuinely new failure after a recovery visible.
 */
async function recordMergeFailure(
  ctx: StudioContext,
  orgId: string,
  taskBoardItemId: string,
  reason: MergeFailureReason,
  detail?: string,
): Promise<void> {
  if (SILENT_REASONS.has(reason)) return;
  const activity = await ctx.storage.taskBoard
    .listActivity(taskBoardItemId, orgId)
    .catch(() => []);
  const newest = activity.at(-1);
  if (
    newest?.action === "merge_failed" &&
    (newest.data as { reason?: unknown } | null)?.reason === reason
  ) {
    return;
  }
  await recordTaskActivity(ctx, {
    taskBoardItemId,
    action: "merge_failed",
    actorId: null,
    data: { reason, ...(detail ? { detail } : {}) },
  });
}

/**
 * Merge the task's open change request. Shared by `shipFromReadyForDeployment`
 * (the Ship button and `auto_merge`) and the conflict paths.
 * Never throws: returns a `{merged: false, reason}` on any failure (no
 * credential, it's gone, a conflict) so the caller can leave it for a human.
 * Merges the newest linked one — the one under review.
 *
 * The strategy ladder and the vocabulary of a refusal belong to the provider
 * implementation, not here: a repository that forbids merge commits and one
 * that forbids a fast-forward answer with different prose and different status
 * codes, and only the implementation knows which of its own strategies is
 * worth trying next.
 *
 * Every failure is BOTH logged and written to the card's timeline. A card
 * staying put with no explanation is the exact shape of the outage this
 * function caused once already: a verified approval, a green mergeable PR, and
 * a card that sat there because the only record of the refusal was a log line
 * nobody was tailing.
 */
async function mergeLinkedPr(
  ctx: StudioContext,
  orgId: string,
  taskBoardItemId: string,
  opts: { allowPendingChecks?: boolean } = {},
): Promise<MergeOutcome> {
  const fail = async (
    reason: MergeFailureReason,
    detail?: string,
  ): Promise<MergeOutcome> => {
    await recordMergeFailure(ctx, orgId, taskBoardItemId, reason, detail);
    return { merged: false, reason, ...(detail ? { detail } : {}) };
  };

  const prs = await ctx.storage.taskBoard.listPrs(taskBoardItemId, orgId);
  const pr = await pickActivePr(ctx, orgId, prs);
  if (!pr) {
    console.warn(
      `[task-board] merge skipped — no linked PR on ${taskBoardItemId}`,
    );
    return fail("no_pr");
  }
  const checks = await fetchPrChecksStatus(ctx, orgId, pr);
  if (checksBlockMerge(checks, opts)) {
    console.warn(
      `[task-board] merge blocked — checks ${checks} on PR #${pr.number}`,
    );
    return fail(checks === "failing" ? "checks_failing" : "checks_pending");
  }
  const origin = originOf(pr);
  const repo = origin.repo.path;
  const client = await changeRequestClientForOrigin(ctx, orgId, origin).catch(
    (err: unknown) => {
      console.error(`[task-board] merge blocked — ${repo}:`, err);
      return null;
    },
  );
  if (!client) {
    console.warn(
      `[task-board] merge blocked — no credential for ${repo} (#${pr.number})`,
    );
    return fail("no_connection", repo);
  }

  const outcome = await client.merge(pr.number);
  if (outcome.merged) {
    /**
     * Drop the polled read cache so the next poll sees the merge → Done.
     * Awaited: the UI refetches as soon as this responds, and the KV delete is
     * a round-trip — firing it and returning races the very poll it is meant
     * to fix.
     */
    await Promise.all([
      invalidatePrReads(readNamespace(pr)),
      invalidatePrCards(orgId),
    ]);
    return { merged: true };
  }
  if (outcome.reason === "rate_limited") {
    console.warn(
      `[task-board] merge rate-limited on #${pr.number} — sweep retries`,
    );
  } else {
    console.error(
      `[task-board] merge refused (${outcome.reason}) on ${repo}#${pr.number}:`,
      outcome.detail,
    );
  }
  return fail(reasonFor(outcome), outcome.detail.slice(0, 500));
}

/** The card's vocabulary for a provider refusal. Pure — unit-tested. */
export function reasonFor(
  outcome: Extract<ProviderMergeOutcome, { merged: false }>,
): MergeFailureReason {
  switch (outcome.reason) {
    case "conflict":
      return "conflict";
    case "rate_limited":
      return "rate_limited";
    // Nothing to merge: the same thing the card means by "no PR".
    case "not_found":
      return "no_pr";
    case "blocked":
      return "refused";
    default:
      return "error";
  }
}

/**
 * True when EVERY enabled reviewer has a token-VERIFIED `approve` as its latest
 * decision in the current review cycle. `verifiedOnly` is the point: a
 * self-asserted approval (missing/wrong reviewToken) must never pass a card
 * on to QA, otherwise an agent could forge the reviewer's verdict. Reads
 * the activity log through the shared cycle reducer (same logic the ship button
 * uses, minus the verification requirement).
 *
 * Lives here rather than in `review-decision.ts` because the sweeper's retry
 * needs it too, and importing it the other way round would be a cycle.
 */
export async function allEnabledReviewersVerifiedApproved(
  ctx: StudioContext,
  orgId: string,
  taskBoardItemId: string,
): Promise<boolean> {
  const settings = await ctx.storage.organizationSettings.get(orgId);
  const enabled = enabledReviewerKinds(settings?.flags);
  const activity = await ctx.storage.taskBoard.listActivity(
    taskBoardItemId,
    orgId,
  );
  const item = await ctx.storage.taskBoard.getById(taskBoardItemId, orgId);
  return allReviewersApproved(activity, enabled, {
    cycleStartedAt: item?.reviewCycleStartedAt ?? null,
    verifiedOnly: true,
  });
}

/**
 * True when every enabled reviewer approved but at least one approval did NOT
 * verify — the card cannot leave review on its own for the rest of this cycle.
 *
 * A reviewer's token binds its decision to its dispatch, so an approval that
 * fails to verify (the model dropped the token from its prompt, or replayed one
 * minted for an earlier cycle) is recorded but doesn't count. Nothing then
 * re-dispatches that reviewer — its claim for the cycle is spent — so the card
 * shows two green approvals on the board and can never merge. One sat like that
 * for seven days. There is no automatic way out, which is exactly what makes it
 * a person's: hand it over rather than sweeping it forever.
 */
async function handUnverifiedApprovalToHuman(
  ctx: StudioContext,
  item: TaskBoardItem,
): Promise<void> {
  const settings = await ctx.storage.organizationSettings.get(
    item.organizationId,
  );
  const enabled = enabledReviewerKinds(settings?.flags);
  const activity = await ctx.storage.taskBoard.listActivity(
    item.id,
    item.organizationId,
  );
  if (
    !approvedButUnverified(activity, enabled, {
      cycleStartedAt: item.reviewCycleStartedAt,
    })
  ) {
    return;
  }
  await handTaskToHuman(
    ctx,
    item,
    "every reviewer approved, but an approval could not be verified — " +
      "the card cannot move to QA on its own and no reviewer can be " +
      "re-dispatched this cycle",
  );
}

/**
 * Whether a failed merge failed because the branch no longer applies. Pure —
 * unit-tested.
 *
 * This used to be a phrase match over the refusal text, plus a second provider
 * read to ask about mergeability. Neither is needed now: the provider
 * implementation classifies its own refusal, and it is the one that knows
 * whether `405 Method Not Allowed` meant a conflict or a policy — so the merge
 * attempt already paid for the answer.
 *
 * Never returns `false`: only `conflict` is evidence, and a `blocked` refusal
 * is not evidence the branch is clean. Callers act on an explicit `true` only.
 */
export function conflictFromOutcome(
  outcome: MergeOutcome | null,
): boolean | null {
  if (outcome === null || outcome.merged) return null;
  return outcome.reason === "conflict" ? true : null;
}

/**
 * Hand a conflicting PR back to the Super Agent to rebase, after a merge from
 * Ready for Deployment was refused for it. The reaction itself re-checks the
 * lane, the approval, the org flag and its own dispatch cap.
 */
async function resolveConflictAfterRefusedMerge(
  ctx: StudioContext,
  item: TaskBoardItem,
  outcome: MergeOutcome,
): Promise<void> {
  const conflict = conflictFromOutcome(outcome);
  if (conflict !== true) return;
  const orgId = item.organizationId;
  const prs = await ctx.storage.taskBoard.listPrs(item.id, orgId);
  // The same one `mergeLinkedPr` just tried to merge.
  const pr = await pickActivePr(ctx, orgId, prs);
  if (!pr) return;
  await reactToApprovedPrConflict(ctx, orgId, item, {
    pr: { number: pr.number, url: pr.url },
    conflict,
  }).catch((err) => {
    console.error("[task-board] conflict auto-resolve failed", err);
  });
}

/**
 * Merge a card's pull request from Ready for Deployment and move the card to
 * Post-deploy Validation. The one merge path: the Ship button calls it, and so
 * does a card reaching the lane when the org has `auto_merge` on.
 *
 * A refused merge leaves the card in place with the reason on its timeline
 * (`mergeLinkedPr`); a conflict goes back to the Super Agent when the org lets
 * it (`reactToApprovedPrConflict`).
 */
export async function shipFromReadyForDeployment(
  ctx: StudioContext,
  item: TaskBoardItem,
  opts: {
    allowPendingChecks?: boolean;
    /** The person who shipped it; analytics reads no actor as the agent. */
    shippedBy?: string | null;
  } = {},
): Promise<{ item: TaskBoardItem; merged: boolean }> {
  const orgId = item.organizationId;
  if (item.status !== LANES.release) return { item, merged: false };
  const outcome = await mergeLinkedPr(ctx, orgId, item.id, {
    allowPendingChecks: opts.allowPendingChecks,
  });
  if (!outcome.merged) {
    await resolveConflictAfterRefusedMerge(ctx, item, outcome);
    const refreshed =
      (await ctx.storage.taskBoard.getById(item.id, orgId)) ?? item;
    emitTaskBoardUpdated(orgId, refreshed);
    return { item: refreshed, merged: false };
  }
  const shipped = await ctx.storage.taskBoard.update(
    item.id,
    orgId,
    { status: LANES.shipped },
    item.updatedBy,
  );
  await recordTaskActivity(ctx, {
    taskBoardItemId: item.id,
    action: "status_changed",
    actorId: opts.shippedBy ?? null,
    data: { from: item.status, to: LANES.shipped },
  });
  emitTaskBoardUpdated(orgId, shipped);
  return { item: shipped, merged: true };
}

/**
 * A card just landed in Ready for Deployment: ship it now when the org merges
 * on arrival (`auto_merge`). Checks still running hold the merge back; the
 * Ship button can override that.
 */
export async function shipOnArrivalIfAutoMerge(
  ctx: StudioContext,
  item: TaskBoardItem,
): Promise<TaskBoardItem> {
  if (item.status !== LANES.release) return item;
  const settings = await ctx.storage.organizationSettings.get(
    item.organizationId,
  );
  if (settings?.flags?.auto_merge !== true) return item;
  return (await shipFromReadyForDeployment(ctx, item)).item;
}

/**
 * Move a card whose review finished to QA, for the cases the verdict itself
 * did not settle: a card the previous release left In Review after an
 * approval, or a verdict whose move failed. Gated on every enabled reviewer
 * having verifiably approved this cycle; an approval that did not verify goes
 * to a person instead, since nothing will re-dispatch that reviewer.
 *
 * Returns true only when this call moved the card.
 */
export async function moveFinishedReviewToQa(
  ctx: StudioContext,
  item: TaskBoardItem,
): Promise<boolean> {
  if (!inReviewPhase(item)) return false;
  if (
    !(await allEnabledReviewersVerifiedApproved(
      ctx,
      item.organizationId,
      item.id,
    ))
  ) {
    await handUnverifiedApprovalToHuman(ctx, item);
    return false;
  }
  return (await moveApprovedCardToQa(ctx, item)) !== null;
}
