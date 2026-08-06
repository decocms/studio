import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import { clientFromConnection } from "@/mcp-clients";
import {
  allReviewersApproved,
  REVIEWER_FLAG,
  REVIEWER_KINDS,
} from "@decocms/shared/task-board";
import { recordTaskActivity } from "./activity";
import { fetchPrChecksStatus, resolveGithubConnection } from "./prs-get";
import { emitTaskBoardUpdated } from "./run-reactions";

/** Cap the merge round-trip so a slow GitHub can't hang the caller. */
const MERGE_TIMEOUT_MS = 15000;

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
  | "refused"
  | "error";

export type MergeOutcome =
  | { merged: true }
  | { merged: false; reason: MergeFailureReason; detail?: string };

/** Reasons worth a timeline entry — see {@link MergeFailureReason}. */
const SILENT_REASONS = new Set<MergeFailureReason>(["checks_pending"]);

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
): Promise<MergeOutcome> {
  const fail = async (
    reason: MergeFailureReason,
    detail?: string,
  ): Promise<MergeOutcome> => {
    await recordMergeFailure(ctx, orgId, taskBoardItemId, reason, detail);
    return { merged: false, reason, ...(detail ? { detail } : {}) };
  };

  const prs = await ctx.storage.taskBoard.listPrs(taskBoardItemId, orgId);
  const pr = prs[0];
  if (!pr) {
    console.warn(
      `[task-board] merge skipped — no linked PR on ${taskBoardItemId}`,
    );
    return fail("no_pr");
  }
  // Never ship on red or in-flight CI — the ship button hides in this case, but
  // guard the server path too (auto-merge, a stale client). Only a definite
  // failing/pending blocks; an unknown (null) does not.
  const checks = await fetchPrChecksStatus(ctx, orgId, pr);
  if (checks === "failing" || checks === "pending") {
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
    const result = await client.callTool(
      {
        name: "merge_pull_request",
        arguments: {
          owner: pr.repoOwner,
          repo: pr.repoName,
          pullNumber: pr.number,
        },
      },
      undefined,
      { timeout: MERGE_TIMEOUT_MS },
    );
    // GitHub refusing the merge (branch protection, a required review, a lost
    // race) comes back as `isError` on an otherwise successful tool call — NOT
    // as a throw, so the catch below never saw it. Surface the payload: this is
    // the case that looks identical to "nothing happened" from the outside.
    if ((result as { isError?: boolean })?.isError) {
      const content = JSON.stringify(
        (result as { content?: unknown })?.content,
      );
      console.error(
        `[task-board] merge refused by GitHub on PR #${pr.number}:`,
        content,
      );
      return fail("refused", content?.slice(0, 500));
    }
    return { merged: true };
  } catch (err) {
    console.error("[task-board] merge PR failed", err);
    return fail("error", err instanceof Error ? err.message : String(err));
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
  const flags = settings?.flags ?? {};
  const enabled = REVIEWER_KINDS.filter(
    (k) => flags[REVIEWER_FLAG[k]] === true,
  );
  const activity = await ctx.storage.taskBoard.listActivity(
    taskBoardItemId,
    orgId,
  );
  return allReviewersApproved(activity, enabled, { verifiedOnly: true });
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
    return false;
  }

  const outcome = await mergeLinkedPr(ctx, orgId, item.id);
  if (!outcome.merged) return false;

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
