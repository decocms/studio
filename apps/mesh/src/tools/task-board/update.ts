import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import {
  SUPER_AGENT_ASSIGNEE_ID,
  TaskBoardItemPrioritySchema,
  TaskBoardItemSchema,
  TaskBoardItemStatusSchema,
} from "./schema";
import { assertValidAssignee } from "./validate-assignee";
import { requireTaskBoardEnabled } from "./require-enabled";
import { enqueueSuperAgentForTask } from "./enqueue-super-agent";
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

    if (input.assigneeId) {
      await assertValidAssignee(ctx, organizationId, input.assigneeId);
    }

    // Only enqueue on the transition INTO Super Agent, not on every later edit.
    const previous =
      input.assigneeId !== undefined
        ? await ctx.storage.taskBoard.getById(input.id, organizationId)
        : null;
    const assigneeChanged =
      input.assigneeId !== undefined &&
      input.assigneeId !== (previous?.assigneeId ?? null);
    // Delegating a task to the Super Agent queues it to run — force To Do,
    // overriding any status the caller passed alongside the reassignment.
    const becameSuperAgent =
      assigneeChanged && input.assigneeId === SUPER_AGENT_ASSIGNEE_ID;

    const item = await ctx.storage.taskBoard.update(
      input.id,
      organizationId,
      {
        title: input.title,
        description: input.description,
        status: becameSuperAgent ? "todo" : input.status,
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

    if (becameSuperAgent) {
      emitTaskBoardUpdated(organizationId, item);
      // Best-effort: the task is already persisted, so a dispatch failure
      // (e.g. no model configured) must not fail the update.
      await enqueueSuperAgentForTask(ctx, item).catch((err) => {
        console.error("[task-board] Super Agent enqueue failed", err);
      });
    }

    return { item };
  },
});
