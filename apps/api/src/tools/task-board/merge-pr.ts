import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import { clientFromConnection } from "@/mcp-clients";
import {
  allReviewersApproved,
  approvedButUnverified,
  enabledReviewerKinds,
} from "@decocms/shared/task-board";
import { recordTaskActivity } from "./activity";
import { reactToApprovedPrConflict } from "./conflict-reaction";
import {
  type ChecksStatus,
  fetchPrChecksStatus,
  fetchPrConflict,
  invalidatePrReads,
  isRateLimitError,
  pickActivePr,
  resolveGithubConnection,
} from "./prs-get";
import { emitTaskBoardUpdated, handTaskToHuman } from "./run-reactions";

/** Cap the merge round-trip so a slow GitHub can't hang the caller. */
const MERGE_TIMEOUT_MS = 15000;

/**
 * Merge methods to try in order, stopping at the first that succeeds. `merge` is
 * first because it is GitHub's own default — a bare `merge_pull_request` asks for
 * a merge commit — so keeping it first changes nothing for every repo that
 * allows one. The fallback is the whole point: a repo with "Allow merge commits"
 * off answers `405 Merge commits are not allowed on this repository`, which used
 * to strand the card In Review forever, retried every sweep against the same
 * refusal; now it advances to `squash`, then `rebase`.
 */
const MERGE_METHODS = ["merge", "squash", "rebase"] as const;

/**
 * True when a merge refusal is GitHub rejecting THIS merge method (a `405 … are
 * not allowed on this repository`) — the one refusal a different method can fix,
 * so the ladder advances on it. Every other refusal (branch protection, a
 * required review, a conflict) is method-independent: no method fixes it, so the
 * caller reports it as-is instead of burning through the ladder. Pure —
 * unit-tested.
 */
export function isMergeMethodNotAllowed(content: string): boolean {
  return (
    /\b405\b/.test(content) && /not allowed on this repository/i.test(content)
  );
}

/**
 * Why a merge didn't happen. `checks_pending` is the one ROUTINE outcome — CI
 * is still running and the next attempt will simply succeed — so it is the one
 * reason that never reaches the card's timeline. Everything else means a human
 * has to do something, and until now they had no way to know.
 */
export type MergeFailureReason =
  | "no_pr"
  | "checks_pending"
  | "checks_failing"
  | "no_connection"
  | "rate_limited"
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

/** The outcome of one `merge_pull_request` round-trip, classified. */
type MergeAttempt =
  | { kind: "merged" }
  | { kind: "rate_limited"; detail: string }
  | { kind: "method_not_allowed"; detail: string }
  | { kind: "refused"; detail: string };

/**
 * Classify a raw `merge_pull_request` tool result. Pure — unit-tested.
 *
 * GitHub refuses a merge (branch protection, a required review, a forbidden
 * method, a lost race) via `isError` on an otherwise-resolved tool call — NOT a
 * throw — so the payload is parsed here. Method-not-allowed is tested BEFORE the
 * rate-limit heuristic on purpose: that heuristic matches a bare `429` anywhere
 * in the payload, which the error's own PR URL can carry (`pulls/429/merge`),
 * while a forbidden-method refusal names itself unambiguously — so it wins the
 * tie and the ladder still advances for PR #429. `detail` defaults to `""` so a
 * refusal with no `content` (which `JSON.stringify` renders as `undefined`, not
 * a string) can't throw downstream.
 */
export function classifyMergeResult(result: unknown): MergeAttempt {
  if (!(result as { isError?: boolean })?.isError) return { kind: "merged" };
  const detail =
    JSON.stringify((result as { content?: unknown })?.content) ?? "";
  if (isMergeMethodNotAllowed(detail)) {
    return { kind: "method_not_allowed", detail };
  }
  if (isRateLimitError(detail)) return { kind: "rate_limited", detail };
  return { kind: "refused", detail };
}

/** One `merge_pull_request` round-trip with a specific `merge_method`. */
async function attemptMerge(
  client: Awaited<ReturnType<typeof clientFromConnection>>,
  pr: { repoOwner: string; repoName: string; number: number },
  mergeMethod: string,
): Promise<MergeAttempt> {
  const result = await client.callTool(
    {
      name: "merge_pull_request",
      arguments: {
        owner: pr.repoOwner,
        repo: pr.repoName,
        pullNumber: pr.number,
        merge_method: mergeMethod,
      },
    },
    undefined,
    { timeout: MERGE_TIMEOUT_MS },
  );
  return classifyMergeResult(result);
}

/**
 * Merge the task's open PR via the GitHub MCP `merge_pull_request` tool. Shared
 * by the reviewer decision (auto-merge on all-approved) and the manual "promote
 * to production" action. Never throws: returns a `{merged: false, reason}` on
 * any failure (no connection, PR gone, merge conflict) so the caller can leave
 * the PR for a human. Merges the newest linked PR — the one under review.
 *
 * Every failure is BOTH logged and written to the card's timeline. The card
 * staying In Review with no explanation is the exact shape of the outage this
 * function caused once already: a verified approval, a green mergeable PR, and
 * a card that sat there because the only record of the refusal was a log line
 * nobody was tailing.
 */
export async function mergeLinkedPr(
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
  const repo = `${pr.repoOwner}/${pr.repoName}`;
  const conn = await resolveGithubConnection(ctx, orgId, pr.connectionId, {
    owner: pr.repoOwner,
    name: pr.repoName,
  });
  if (!conn) {
    console.warn(
      `[task-board] merge blocked — no active GitHub connection for ` +
        `${repo} (PR #${pr.number})`,
    );
    return fail("no_connection", repo);
  }
  const client = await clientFromConnection(conn, ctx, true);
  try {
    // Try each allowed merge method in turn — see {@link MERGE_METHODS}.
    let lastRefusal: string | null = null;
    for (const mergeMethod of MERGE_METHODS) {
      const attempt = await attemptMerge(client, pr, mergeMethod);
      if (attempt.kind === "merged") {
        // Drop the polled read cache so the next poll sees `merged` → Done.
        invalidatePrReads(conn.id);
        return { merged: true };
      }
      // A 429 says nothing about the method; re-asking IS the burst — stop.
      if (attempt.kind === "rate_limited") {
        console.warn(
          `[task-board] merge rate-limited on PR #${pr.number} — sweep retries`,
        );
        return fail("rate_limited", attempt.detail.slice(0, 500));
      }
      // The repo forbids THIS method — remember it and try the next.
      if (attempt.kind === "method_not_allowed") {
        console.warn(
          `[task-board] merge method '${mergeMethod}' not allowed on ${repo} — trying next`,
        );
        lastRefusal = attempt.detail;
        continue;
      }
      // Method-independent refusal (branch protection, conflict) — no method fixes it.
      console.error(
        `[task-board] merge refused by GitHub on PR #${pr.number}:`,
        attempt.detail,
      );
      return fail("refused", attempt.detail.slice(0, 500));
    }
    // The repo allows none of squash/merge/rebase — report the last refusal.
    console.error(
      `[task-board] no merge method allowed on ${repo} (PR #${pr.number})`,
      lastRefusal,
    );
    return fail("refused", lastRefusal?.slice(0, 500));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Same 429, thrown rather than returned — the transport decides which.
    if (isRateLimitError(err)) return fail("rate_limited", detail);
    console.error("[task-board] merge PR failed", err);
    return fail("error", detail);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * True when EVERY enabled reviewer has a token-VERIFIED `approve` as its latest
 * decision in the current review cycle. `verifiedOnly` is the point: a
 * self-asserted approval (missing/wrong reviewToken) must never trigger an
 * automatic merge, otherwise one agent could forge the two-reviewer gate. Reads
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
  return allReviewersApproved(activity, enabled, { verifiedOnly: true });
}

/**
 * True when every enabled reviewer approved but at least one approval did NOT
 * verify — the auto-merge gate is unsatisfiable for the rest of this cycle.
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
  if (!approvedButUnverified(activity, enabled)) return;
  await handTaskToHuman(
    ctx,
    item,
    "every reviewer approved, but an approval could not be verified — " +
      "auto-merge is blocked and no reviewer can be re-dispatched this cycle",
  );
}

/**
 * True when a merge outcome is worth a `pull_request_read` to ask GitHub
 * whether the PR conflicts. Pure — unit-tested.
 *
 * Only a refusal can be a conflict; every other reason (no PR, no connection,
 * red or pending checks) is definitely not one. `rate_limited` is a separate
 * reason precisely so it lands here: it says nothing about mergeability, and
 * paying another GitHub call into a 429 is the burst that keeps the limit shut.
 */
export function mayBeConflict(
  outcome: MergeOutcome,
): outcome is { merged: false; reason: MergeFailureReason; detail?: string } {
  return !outcome.merged && outcome.reason === "refused";
}

/**
 * Whether the PR conflicts, given the `pull_request_read` answer and the merge
 * outcome it followed. Pure — unit-tested.
 *
 * The read wins when it HAS an answer. When it doesn't — GitHub computes
 * mergeability asynchronously, so `null` is routine — fall back to what the
 * refusal said (`405 Pull Request has merge conflicts`). That is the
 * definitive answer and we already paid for it: the merge just asked GitHub to
 * do the thing and was told exactly why it couldn't. Without the fallback a
 * null read silently skips the resolution run, and the card sits approved and
 * unmergeable.
 *
 * Never returns `false` from the refusal alone: the phrase being absent is not
 * evidence the PR is mergeable, and only an explicit `true` may act.
 */
export function conflictSignal(
  read: boolean | null,
  outcome: MergeOutcome | null,
): boolean | null {
  if (read !== null) return read;
  if (outcome === null || !mayBeConflict(outcome)) return null;
  return (outcome.detail ?? "").toLowerCase().includes("merge conflict")
    ? true
    : null;
}

/**
 * Hand an approved-but-conflicting PR back to the Super Agent to rebase.
 *
 * The inline approval path does this (`review-decision.ts`), but the SWEEP's
 * retry didn't — so a conflict that appeared after the approval (the base
 * branch moved on, which is the common case for a card that waited) left the
 * card retrying the same 405 every five minutes, forever, with no run ever
 * dispatched to fix it. Two cards in one org, `merge_conflict_resolution` count
 * zero across the whole board.
 *
 * `mayBeConflict` decides which outcomes are worth the extra GitHub read; the
 * reaction itself re-checks approval, the org flag and its own dispatch cap.
 */
async function resolveConflictAfterRefusedMerge(
  ctx: StudioContext,
  item: TaskBoardItem,
  outcome: MergeOutcome,
): Promise<void> {
  if (!mayBeConflict(outcome)) return;
  const orgId = item.organizationId;
  const prs = await ctx.storage.taskBoard.listPrs(item.id, orgId);
  // The same PR `mergeLinkedPr` just tried to merge.
  const pr = await pickActivePr(ctx, orgId, prs);
  if (!pr) return;
  await reactToApprovedPrConflict(ctx, orgId, item, {
    pr: { number: pr.number, url: pr.url },
    conflict: conflictSignal(await fetchPrConflict(ctx, orgId, pr), outcome),
  }).catch((err) => {
    console.error("[task-board] sweep conflict auto-resolve failed", err);
  });
}

/**
 * Retry the auto-merge for a card that finished its review but never shipped.
 *
 * The reviewer decision merges inline, and when that merge fails the card is
 * simply left In Review — the review cycle's claim is spent, so NOTHING
 * re-dispatches and nothing re-attempts. A transient GitHub blip, or a deleted
 * connection later restored, therefore stranded the card permanently. This is
 * the resumption: idempotent, safe to call every sweep, and gated on exactly
 * the state the inline path required (In Review + auto-merge on + every enabled
 * reviewer verifiably approved), so it can never ship something the reviewers
 * didn't.
 *
 * Returns true only when this call actually merged and advanced the card.
 */
export async function retryAutoMergeIfApproved(
  ctx: StudioContext,
  item: TaskBoardItem,
): Promise<boolean> {
  const orgId = item.organizationId;
  if (item.status !== "in_review") return false;
  const settings = await ctx.storage.organizationSettings.get(orgId);
  if (settings?.flags?.auto_merge !== true) return false;
  if (!(await allEnabledReviewersVerifiedApproved(ctx, orgId, item.id))) {
    await handUnverifiedApprovalToHuman(ctx, item);
    return false;
  }

  const outcome = await mergeLinkedPr(ctx, orgId, item.id);
  if (!outcome.merged) {
    await resolveConflictAfterRefusedMerge(ctx, item, outcome);
    return false;
  }

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
    data: { from: item.status, to: "done" },
  });
  emitTaskBoardUpdated(orgId, done);
  return true;
}
