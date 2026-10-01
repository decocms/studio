import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import { taskCommentAttachmentDir } from "@decocms/shared/task-comment-attachments";
import { deleteAttachmentFiles } from "./comment-attachments";
import { emitTaskBoardDeleted } from "./run-reactions";

export const TASK_BOARD_ITEM_DELETE = defineTool({
  name: "TASK_BOARD_ITEM_DELETE",
  description:
    "Delete a task board item. A Deco Score task also dismisses its " +
    "finding, so the next Deco Score import won't re-create the card.",
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
    const actor = getUserId(ctx) ?? "system";
    const outcome = await ctx.storage.taskBoard.delete(
      input.id,
      organizationId,
      actor,
    );
    if (!outcome) {
      throw new Error(`Task board item not found: ${input.id}`);
    }
    // A dismissed card keeps its comments for a restore, so only a real delete takes their files.
    if (outcome === "deleted") {
      await deleteAttachmentFiles(
        ctx.orgFs,
        [taskCommentAttachmentDir(input.id)],
        actor,
      );
    }
    // Broadcast the removal so every open board drops the card live.
    emitTaskBoardDeleted(organizationId, input.id);
    return { success: true };
  },
});
