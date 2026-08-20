import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import {
  allReviewersApproved,
  enabledReviewerKinds,
  type ReviewCycleActivity,
  type ReviewerKind,
} from "@decocms/shared/task-board";
import { flagsForRepo } from "@decocms/shared/organization/schema";
import { TaskBoardItemStatusSchema } from "./schema";
import { recordTaskActivity } from "./activity";
import { emitTaskBoardUpdated } from "./run-reactions";
import { mergeLinkedPr } from "./merge-pr";

/**
 * The board only shows "Ship to production" once the task is In Review and
 * every enabled reviewer approved (`reviewsSatisfiedForPromotion` on the web
 * side) — but that's client-side gating only. Without this check here, any
 * caller of this tool (a decopilot agent, a stale client, a direct MCP call)
 * could merge ANY task's linked PR — todo, in_progress, unreviewed — bypassing
 * the QA Agent / Code Reviewer gate entirely.
 */
export function isReadyToShip(
  status: TaskBoardItem["status"],
  activity: ReviewCycleActivity[],
  enabled: ReviewerKind[],
): boolean {
  if (status !== "in_review") return false;
  return enabled.length === 0 || allReviewersApproved(activity, enabled);
}

export const TASK_BOARD_PROMOTE_TO_PRODUCTION = defineTool({
  name: "TASK_BOARD_PROMOTE_TO_PRODUCTION",
  description:
    "Ship a reviewed task: merge its open pull request and move the task to " +
    "Done. Used by the board's 'Ship to production' button after the enabled " +
    "reviewers approved, when auto-merge is off (a human does the final merge).",
  annotations: {
    title: "Ship to Production",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    // Merges a PR on GitHub.
    openWorldHint: true,
  },
  inputSchema: z.object({ taskBoardItemId: z.string() }),
  outputSchema: z.object({
    status: TaskBoardItemStatusSchema,
    merged: z.boolean().describe("True when the PR was merged."),
  }),
  handler: async ({ taskBoardItemId }, ctx) => {
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

    const settings = await ctx.storage.organizationSettings.get(organizationId);
    const enabled = enabledReviewerKinds(flagsForRepo(settings, item.repo));
    const activity = await ctx.storage.taskBoard.listActivity(
      taskBoardItemId,
      organizationId,
    );
    if (!isReadyToShip(item.status, activity, enabled)) {
      throw new Error(
        "Task is not ready to ship: it must be In Review with every enabled reviewer approved",
      );
    }

    // A refused merge is already on the card's timeline (`mergeLinkedPr` writes
    // the reason), so the button no longer looks like it did nothing.
    const outcome = await mergeLinkedPr(ctx, organizationId, taskBoardItemId, {
      // The human clicked Ship, so in-flight CI doesn't block — only red does.
      allowPendingChecks: true,
    });
    if (!outcome.merged) {
      const refreshed =
        (await ctx.storage.taskBoard.getById(
          taskBoardItemId,
          organizationId,
        )) ?? item;
      emitTaskBoardUpdated(organizationId, refreshed);
      return { status: item.status, merged: false };
    }

    const updated = await ctx.storage.taskBoard.update(
      taskBoardItemId,
      organizationId,
      { status: "done" },
      item.updatedBy,
    );
    if (item.status !== "done") {
      await recordTaskActivity(ctx, {
        taskBoardItemId,
        action: "status_changed",
        actorId: null,
        data: { from: item.status, to: "done" },
      });
    }
    emitTaskBoardUpdated(organizationId, updated);
    return { status: updated.status, merged: true };
  },
});
