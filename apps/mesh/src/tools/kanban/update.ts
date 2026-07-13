import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import {
  KanbanTaskPrioritySchema,
  KanbanTaskSchema,
  KanbanTaskStatusSchema,
} from "./schema";
import { assertValidAssignee } from "./validate-assignee";
import { requireKanbanEnabled } from "./require-enabled";

export const KANBAN_TASK_UPDATE = defineTool({
  name: "KANBAN_TASK_UPDATE",
  description:
    "Update a kanban board task's fields (title, description, status, priority, assignee).",
  annotations: {
    title: "Update Kanban Task",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string(),
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    status: KanbanTaskStatusSchema.optional(),
    priority: KanbanTaskPrioritySchema.optional(),
    assigneeId: z.string().nullable().optional(),
  }),
  outputSchema: z.object({ item: KanbanTaskSchema }),
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

    if (input.assigneeId) {
      await assertValidAssignee(ctx, organizationId, input.assigneeId);
    }

    const item = await ctx.storage.kanbanTasks.update(
      input.id,
      organizationId,
      {
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        assigneeId: input.assigneeId,
      },
      getUserId(ctx)!,
    );

    return { item };
  },
});
