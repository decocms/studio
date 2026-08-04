import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import { isReportsTask } from "../../billing/task-quota";
import { emitTaskBoardDeleted } from "./run-reactions";

export const TASK_BOARD_ITEM_DELETE = defineTool({
  name: "TASK_BOARD_ITEM_DELETE",
  description: "Delete a task board item.",
  annotations: {
    title: "Delete Task Board Item",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ success: z.boolean() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    // Reports-pushed tasks are the report's findings — their lifecycle is
    // owned by the reports sync, never deletable from the board.
    const item = await ctx.storage.taskBoard.getById(input.id, organizationId);
    if (item && isReportsTask(item)) {
      throw new Error(
        "This task was generated from your report and can't be deleted.",
      );
    }

    await ctx.storage.taskBoard.delete(input.id, organizationId);
    // Broadcast the removal so every open board drops the card live.
    emitTaskBoardDeleted(organizationId, input.id);
    return { success: true };
  },
});
