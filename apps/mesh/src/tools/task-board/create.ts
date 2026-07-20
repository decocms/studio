import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import {
  TaskBoardItemPrioritySchema,
  TaskBoardItemSchema,
  TaskBoardItemStatusSchema,
} from "./schema";
import { resolveValidAssignee } from "./resolve-assignee";
import { requireTaskBoardEnabled } from "./require-enabled";
import { reactToAgentDelegation } from "./enqueue-agent";
import { emitTaskBoardUpdated } from "./run-reactions";

export const TASK_BOARD_ITEM_CREATE = defineTool({
  name: "TASK_BOARD_ITEM_CREATE",
  description: "Create a new task board item for the organization.",
  annotations: {
    title: "Create Task Board Item",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    status: TaskBoardItemStatusSchema.optional(),
    priority: TaskBoardItemPrioritySchema.optional(),
    assigneeId: z.string().nullable().optional(),
    dueDate: z.string().datetime().nullable().optional(),
  }),
  outputSchema: z.object({ item: TaskBoardItemSchema }),
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

    // Resolve + validate the assignee once: a truthy result is an agent (the
    // Super Agent or a code agent) the task is delegated to; null is a human
    // member. Throws if the assignee is neither.
    const delegatedAgent = input.assigneeId
      ? await resolveValidAssignee(ctx, organizationId, input.assigneeId)
      : null;

    const item = await ctx.storage.taskBoard.create({
      organizationId,
      title: input.title,
      description: input.description ?? null,
      // A task handed to an agent is queued to run — land it in To Do.
      status: delegatedAgent ? "todo" : input.status,
      priority: input.priority,
      assigneeId: input.assigneeId ?? null,
      assignedBy: input.assigneeId ? getUserId(ctx)! : null,
      dueDate: input.dueDate ?? null,
      by: getUserId(ctx)!,
    });

    // Broadcast the new card so every open board adds it live, no polling.
    emitTaskBoardUpdated(organizationId, item);
    await reactToAgentDelegation(ctx, item, delegatedAgent);

    return { item };
  },
});
