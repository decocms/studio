/**
 * Run the Reviewer on a task by hand.
 *
 * An org that turns `reviewer_enabled` off gets no automated review at all —
 * `enqueueEnabledReviewers` reads the flag and returns before it looks at the
 * card. That is the setting working as intended for the general case, and the
 * wrong answer for the one card a human wants a second pair of eyes on: the
 * Super Agent has finished, the pull request is open, and the only way to get
 * it reviewed was to flip the org-wide setting on, wait for the sweeper, and
 * flip it back.
 *
 * So this is the per-card escape hatch, and it overrides EXACTLY one thing: the
 * org setting. Every other gate in `enqueueEnabledReviewers` still runs — a
 * live author run defers it, the attempt cap still caps it, and a reviewer
 * already on this review cycle still owns it. That is what makes pressing the
 * button twice harmless.
 *
 * The two refusals below are the states a human can act on (wait, or get a pull
 * request opened); every other skip comes back as `queued: false`.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import { REVIEWER_KINDS } from "@decocms/shared/task-board";
import { authorRunLive, enqueueEnabledReviewers } from "./enqueue-reviewer";

export const TASK_BOARD_RUN_REVIEWER = defineTool({
  name: "TASK_BOARD_RUN_REVIEWER",
  description:
    "Run the Reviewer on a task board item even when the organization has " +
    "automated review turned off. Use this for a task whose Super Agent run " +
    "finished and whose pull request nobody reviewed. Does nothing if a " +
    "reviewer is already working this review cycle.",
  annotations: {
    title: "Run Reviewer",
    readOnlyHint: false,
    // Starts an agent run that pushes fixes to the PR's branch.
    destructiveHint: true,
    // Re-pressing it while a reviewer holds the cycle dispatches nothing.
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    id: z.string().describe("The task board item to review."),
  }),
  outputSchema: z.object({
    queued: z
      .boolean()
      .describe(
        "False when a reviewer already holds this review cycle, so nothing " +
          "was dispatched.",
      ),
  }),
  handler: async ({ id }, ctx) => {
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

    // A review is a verdict on a pull request; with none linked the run is spent discovering that.
    const prs = await ctx.storage.taskBoard.listPrs(id, organizationId);
    if (prs.length === 0) {
      throw new Error(
        "This task has no pull request to review yet. Wait for the Super " +
          "Agent to open one.",
      );
    }
    if (authorRunLive(item, Date.now())) {
      throw new Error(
        "The Super Agent is still working this task — wait for its run to " +
          "finish before asking for a review.",
      );
    }

    const dispatched = await enqueueEnabledReviewers(ctx, item, {
      kinds: REVIEWER_KINDS,
    });
    return { queued: dispatched.length > 0 };
  },
});
