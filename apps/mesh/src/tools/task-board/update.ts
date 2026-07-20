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

export const TASK_BOARD_ITEM_UPDATE = defineTool({
  name: "TASK_BOARD_ITEM_UPDATE",
  description:
    "Update a task board item's fields (title, description, status, priority, assignee).",
  annotations: {
    title: "Update Task Board Item",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string(),
    title: z.string().min(1).optional(),
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

    // Only enqueue on the transition INTO an agent, not on every later edit.
    const previous =
      input.assigneeId !== undefined
        ? await ctx.storage.taskBoard.getById(input.id, organizationId)
        : null;
    const assigneeChanged =
      input.assigneeId !== undefined &&
      input.assigneeId !== (previous?.assigneeId ?? null);
    // Delegating a task to an agent queues it to run — force To Do, overriding
    // any status the caller passed alongside the reassignment.
    const becameAgent = assigneeChanged && delegatedAgent !== null;

    const item = await ctx.storage.taskBoard.update(
      input.id,
      organizationId,
      {
        title: input.title,
        description: input.description,
        status: becameAgent ? "todo" : input.status,
        priority: input.priority,
        assigneeId: input.assigneeId,
        // Stamp who delegated only when the assignee actually changes.
        assignedBy: assigneeChanged
          ? input.assigneeId
            ? getUserId(ctx)!
            : null
          : undefined,
        dueDate: input.dueDate,
      },
      getUserId(ctx)!,
    );

    // Broadcast the delegation flip (assignee + forced To Do) so every open
    // board reflects it live. Plain edits already round-trip through the
    // mutation's optimistic patch + invalidate on the acting client.
    if (becameAgent) {
      emitTaskBoardUpdated(organizationId, item);
      await reactToAgentDelegation(ctx, item, delegatedAgent);
    }

    return { item };
  },
});
