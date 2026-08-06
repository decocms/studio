/**
 * `TASK_BOARD_ITEM_PR_LINK` — the agent tells us which PR it opened.
 *
 * Until this existed, a `claude-code` task run's PR reached the board only by
 * guesswork: `capturePrForRun` scans tool results, but that hook only sees the
 * NATIVE Decopilot loop, and Claude Code runs `gh pr create` inside a sandbox
 * pod. The fallback was `extractPrFromText(thread.lastMessage)` — a regex over
 * the run's closing message (`prs-get`, `review-sweeper`). A run that signs off
 * with "PR #269 opened" instead of the full URL links nothing, and a card with
 * no linked PR never reaches a reviewer: `enqueueEnabledReviewers` is only
 * called for a task whose PR is ready. That is a silent strand, and the failure
 * mode of every heuristic here — the URL is in the pod's stdout, not in the
 * sentence the model chose to write.
 *
 * So the run states it. The heuristics stay as the floor for runs that don't
 * call this (older harnesses, a PR opened mid-conversation), but the intended
 * path is now deterministic.
 *
 * `threadId` comes from the task-run MCP path, never the input — same reason as
 * `TASK_ADD_REPO`: the per-run key is fully privileged, so a thread argument
 * would let one run write onto another's card.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth, requireOrganization } from "@/core/studio-context";
import { extractPrFromText } from "./pr-extract";
import { resolveRunTaskTargets } from "./run-reactions";
import { requireTaskRunContext } from "./task-run-context";

export const TASK_BOARD_ITEM_PR_LINK = defineTool({
  name: "TASK_BOARD_ITEM_PR_LINK",
  description:
    "Link the pull request you just opened to this run's task board item. Call " +
    "this right after `gh pr create` succeeds, with the PR URL it printed. " +
    "Reviewers (QA, code review) are dispatched from the linked PR, so a task " +
    "whose PR is not linked never gets reviewed.",
  annotations: {
    title: "Link Pull Request to Task",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    url: z
      .string()
      .describe(
        "The pull request URL, e.g. https://github.com/owner/repo/pull/123",
      ),
  }),
  outputSchema: z.object({
    url: z.string(),
    prNumber: z.number(),
    /** Task board items the PR was linked to (empty means the run has no card). */
    taskBoardItemIds: z.array(z.string()),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = requireOrganization(ctx).id;
    const { threadId } = requireTaskRunContext();

    const pr = extractPrFromText(input.url);
    if (!pr) {
      throw new Error(
        `Not a GitHub pull request URL: ${input.url} ` +
          "(expected https://github.com/<owner>/<repo>/pull/<number>)",
      );
    }

    const taskBoardItemIds = await resolveRunTaskTargets(
      ctx,
      organizationId,
      threadId,
    );
    // linkPr is idempotent per (task, url), so re-calling this is free.
    for (const taskBoardItemId of taskBoardItemIds) {
      await ctx.storage.taskBoard.linkPr({
        taskBoardItemId,
        organizationId,
        url: pr.url,
        prNumber: pr.number,
        repoOwner: pr.owner,
        repoName: pr.repo,
      });
      // The sweeper is what hands the card to the reviewers, and it may have
      // just claimed this card's 5-minute budget while it had no PR to look at.
      // Make it due again so the hand-off happens on the next tick (<=60s).
      await ctx.storage.taskBoard.clearSweepBudget(
        taskBoardItemId,
        organizationId,
      );
    }

    return { url: pr.url, prNumber: pr.number, taskBoardItemIds };
  },
});
