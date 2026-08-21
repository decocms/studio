/**
 * Hand an approved-but-conflicting PR back to the Super Agent to resolve, on a
 * human's explicit request from the PR card.
 *
 * This is the manual twin of `reactToApprovedPrConflict` (the automatic,
 * `auto_merge`-gated poll reaction). When a PR is reviewed and ready but can't
 * merge because it conflicts with its base branch, the card must NOT keep
 * offering "Ship to production" (the merge would 405) — it offers "Resolve
 * conflict" instead, and that button lands here. Unlike the automatic path this
 * is NOT gated on `auto_merge` or a self-cap: a person clicked it, so the only
 * gates are the paywall and the shared dispatch fence.
 *
 * Reuses the exact machinery the automatic reaction does — the atomic
 * `claimConflictResolution` fence (In Review + Super Agent → In Progress) so a
 * click racing the poll can't double-dispatch, and `enqueueSuperAgentForTask`
 * with `{ pr, resolveConflict: true }` so the re-run checks out the SAME PR's
 * branch, merges the base, and pushes — rather than opening a second PR.
 *
 * The `claimConflictResolution` fence returning null means we lost the race (the
 * poll's `reactToApprovedPrConflict` fired first, or a human reassigned the task
 * away from the Super Agent) — the winner already queued the run, so we stop.
 * On an enqueue failure the fence has already bounced the status to In Progress,
 * so we bounce it back to In Review (the button only shows there) and rethrow.
 * The `merge_conflict_resolution` activity is recorded AFTER the dispatch (a
 * throw must not spend a conflict-cap slot) with a null actor, matching the
 * automatic reaction's entry so the timeline reads it as the agent resolving.
 *
 * The conflict is re-confirmed server-side before acting: the card's `mergeable`
 * is only a poll snapshot, and only an explicit `true` proceeds — a `null`
 * (unknown / read failed) is never read as a conflict, the same polarity used
 * everywhere else.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import {
  ensureTaskExecutionAllowed,
  userInitiatedTaskQuotaConfig,
} from "@/billing/task-quota";
import { recordTaskActivity } from "./activity";
import { emitTaskBoardUpdated } from "./run-reactions";
import { enqueueSuperAgentForTask } from "./enqueue-super-agent";
import { fetchPrConflict } from "./prs-get";

export const TASK_BOARD_RESOLVE_CONFLICT = defineTool({
  name: "TASK_BOARD_RESOLVE_CONFLICT",
  description:
    "Hand a task's pull request back to the Super Agent to resolve a merge " +
    "conflict with its base branch. Use when a reviewed PR can't be shipped " +
    "because it conflicts. Bounces the task to In Progress and queues a run " +
    "that checks out the existing PR's branch, merges the base, resolves the " +
    "conflicts, and pushes to the same PR.",
  annotations: {
    title: "Resolve Merge Conflict",
    readOnlyHint: false,
    // Starts a run that will push commits to the PR's branch.
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    id: z.string().describe("The task board item whose PR conflicts."),
    prNumber: z
      .number()
      .describe("The conflicting pull request's number, linked to this task."),
  }),
  outputSchema: z.object({
    status: z
      .string()
      .describe("The task's lane after the resolution run was queued."),
  }),
  handler: async ({ id, prNumber }, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const item = await ctx.storage.taskBoard.getById(id, organizationId);
    if (!item) throw new Error(`Task board item not found: ${id}`);

    // Validate the PR is really linked to this task, not trusting the caller.
    const prs = await ctx.storage.taskBoard.listPrs(id, organizationId);
    const pr = prs.find((p) => p.number === prNumber);
    if (!pr) {
      throw new Error(`Pull request #${prNumber} is not linked to this task.`);
    }

    // Re-confirm the conflict server-side (see doc above); only `true` proceeds.
    const conflict = await fetchPrConflict(ctx, organizationId, pr).catch(
      () => null,
    );
    if (conflict !== true) {
      throw new Error(
        "This pull request no longer has a merge conflict — refresh and try again.",
      );
    }

    // Paywall before any write; exempt from the per-task run cap (human-asked).
    await ensureTaskExecutionAllowed(ctx, item, userInitiatedTaskQuotaConfig());

    // Atomic dispatch fence shared with the automatic reaction (see doc above).
    const claimed = await ctx.storage.taskBoard.claimConflictResolution(
      id,
      organizationId,
      getUserId(ctx)!,
    );
    if (!claimed) {
      throw new Error(
        "Couldn't start conflict resolution — the task may have moved, been " +
          "reassigned, or already be resolving. Refresh and try again.",
      );
    }
    emitTaskBoardUpdated(organizationId, claimed);

    try {
      await enqueueSuperAgentForTask(ctx, claimed, {
        pr: { number: pr.number, url: pr.url },
        resolveConflict: true,
        runClass: "retry",
        userInitiated: true,
      });
    } catch (err) {
      // Dispatch failed after the fence bounced the status — bounce it back.
      await ctx.storage.taskBoard
        .update(claimed.id, organizationId, { status: "in_review" }, "system")
        .then((reverted) => emitTaskBoardUpdated(organizationId, reverted))
        .catch((revertErr) =>
          console.error(
            "[task-board] resolve-conflict status revert failed",
            revertErr,
          ),
        );
      throw err;
    }

    await recordTaskActivity(ctx, {
      taskBoardItemId: id,
      action: "merge_conflict_resolution",
      actorId: null,
      data: { prNumber: pr.number },
    });

    return { status: claimed.status };
  },
});
