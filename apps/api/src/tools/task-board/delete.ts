import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import { emitTaskBoardDeleted } from "./run-reactions";

export const TASK_BOARD_ITEM_DELETE = defineTool({
  name: "TASK_BOARD_ITEM_DELETE",
  description:
    "Delete a task board item. A reports-pushed task also dismisses its " +
    "finding, so the next diagnostic import won't re-create the card.",
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

    // Storage dismisses a reports task instead of dropping the row.
    await ctx.storage.taskBoard.delete(
      input.id,
      organizationId,
      getUserId(ctx) ?? "system",
    );
    // Broadcast the removal so every open board drops the card live.
    emitTaskBoardDeleted(organizationId, input.id);
    return { success: true };
  },
});
