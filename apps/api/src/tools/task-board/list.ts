import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import { TaskBoardItemSchema } from "./schema";
import { recoverStalledTasks } from "./stall-recovery";

export const TASK_BOARD_ITEM_LIST = defineTool({
  name: "TASK_BOARD_ITEM_LIST",
  description: "List all task board items for the organization.",
  annotations: {
    title: "List Task Board Items",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({ items: z.array(TaskBoardItemSchema) }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const items = await ctx.storage.taskBoard.list(organizationId);

    // Opening the board is the stall-recovery trigger: re-run the thread-finish
    // decision over the list we just loaded, for the cards whose finish hook
    // missed. Fire-and-forget — a stuck card must not slow down or break the
    // read, and the returned list is deliberately the pre-recovery one (the
    // moves broadcast over SSE, which is how the board already learns them).
    void recoverStalledTasks(ctx, items);

    return { items };
  },
});
