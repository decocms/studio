import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import { TaskBoardItemSchema } from "./schema";

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
    return { items };
  },
});
