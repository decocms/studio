import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import { LANES } from "@decocms/shared/task-board";
import { TaskBoardItemStatusSchema } from "./schema";
import { shipFromReadyForDeployment } from "./merge-pr";

export const TASK_BOARD_PROMOTE_TO_PRODUCTION = defineTool({
  name: "TASK_BOARD_PROMOTE_TO_PRODUCTION",
  description:
    "Ship a task in Ready for Deployment: merge its open pull request and " +
    "move the task to Post-deploy Validation. Used by the board's 'Ship to " +
    "production' button.",
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

    // The lane is the gate: a card reaches Ready for Deployment past the
    // reviewer, QA and the customer's approval. The board only offers the
    // button there too, but any caller of this tool reaches the merge.
    if (item.status !== LANES.release) {
      throw new Error(
        "Task is not ready to ship: move it to Ready for Deployment first.",
      );
    }

    // A refused merge is already on the card's timeline (`mergeLinkedPr` writes
    // the reason), so the button no longer looks like it did nothing.
    const shipped = await shipFromReadyForDeployment(ctx, item, {
      // The human clicked Ship, so in-flight CI doesn't block — only red does.
      allowPendingChecks: true,
    });
    return { status: shipped.item.status, merged: shipped.merged };
  },
});
