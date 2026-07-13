import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import { requireKanbanEnabled } from "./require-enabled";

export const KANBAN_TASK_DELETE = defineTool({
  name: "KANBAN_TASK_DELETE",
  description: "Delete a kanban board task.",
  annotations: {
    title: "Delete Kanban Task",
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

    await requireKanbanEnabled(ctx, organizationId);

    await ctx.storage.kanbanTasks.delete(input.id, organizationId);
    return { success: true };
  },
});
