import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import { KanbanTaskSchema } from "./schema";
import { requireKanbanEnabled } from "./require-enabled";

export const KANBAN_TASK_LIST = defineTool({
  name: "KANBAN_TASK_LIST",
  description: "List all kanban board tasks for the organization.",
  annotations: {
    title: "List Kanban Tasks",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({ items: z.array(KanbanTaskSchema) }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    await requireKanbanEnabled(ctx, organizationId);

    const items = await ctx.storage.kanbanTasks.list(organizationId);
    return { items };
  },
});
