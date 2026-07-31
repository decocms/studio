import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import { TaskBoardItemStatusSchema } from "./schema";
import { recordTaskActivity } from "./activity";
import { emitTaskBoardUpdated } from "./run-reactions";
import { mergeLinkedPr } from "./merge-pr";

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

    const merged = await mergeLinkedPr(ctx, organizationId, taskBoardItemId);
    if (!merged) return { status: item.status, merged: false };

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
