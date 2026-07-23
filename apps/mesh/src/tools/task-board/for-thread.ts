import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import { requireTaskBoardEnabled } from "./require-enabled";

export const TASK_BOARD_ITEM_FOR_THREAD = defineTool({
  name: "TASK_BOARD_ITEM_FOR_THREAD",
  description:
    "Resolve the task board item a chat thread is linked to (reverse lookup). Returns null when the thread belongs to no task.",
  annotations: {
    title: "Get Task Board Item for Thread",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ threadId: z.string() }),
  outputSchema: z.object({ taskId: z.string().nullable() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    await requireTaskBoardEnabled(ctx, organizationId);

    const taskIds = await ctx.storage.taskBoard.linkedTaskIds(
      input.threadId,
      organizationId,
    );
    // A thread links to at most one task in practice; surface the first.
    return { taskId: taskIds[0] ?? null };
  },
});
