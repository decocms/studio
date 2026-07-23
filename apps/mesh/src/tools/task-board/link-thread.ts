import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import { requireTaskBoardEnabled } from "./require-enabled";
import { emitTaskBoardUpdated } from "./run-reactions";

export const TASK_BOARD_ITEM_LINK_THREAD = defineTool({
  name: "TASK_BOARD_ITEM_LINK_THREAD",
  description:
    "Link an existing chat thread to a task board item so it appears on the task.",
  annotations: {
    title: "Link Thread to Task Board Item",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ id: z.string(), threadId: z.string() }),
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

    await requireTaskBoardEnabled(ctx, organizationId);

    // Scope by tenant: only link into a task this org actually owns.
    const item = await ctx.storage.taskBoard.getById(input.id, organizationId);
    if (!item) throw new Error(`Task board item not found: ${input.id}`);

    await ctx.storage.taskBoard.linkThread(
      input.id,
      input.threadId,
      organizationId,
    );

    // Re-read so the broadcast (and caller) carries the freshly linked thread.
    const updated = await ctx.storage.taskBoard.getById(
      input.id,
      organizationId,
    );
    if (updated) emitTaskBoardUpdated(organizationId, updated);

    return { success: true };
  },
});
