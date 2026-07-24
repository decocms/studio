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
import { reactToSuperAgentDelegation } from "./enqueue-super-agent";
import { reactToColumnEntry } from "./column-automation";
import { recordTaskActivity } from "./activity";
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
    /** Custom-column placement (must belong to the org's board settings and
     *  match `status`'s stage — pass both together). */
    columnId: z.string().nullable().optional(),
    tags: z.array(z.string().min(1).max(60)).max(20).optional(),
    sprintId: z.string().nullable().optional(),
  }),
  outputSchema: z.object({
    item: TaskBoardItemSchema,
    /** Present when the task was delegated to the Super Agent but its run
     *  couldn't start (e.g. no AI model configured) — surfaced to the user. */
    superAgentError: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    if (input.assigneeId) {
      await assertValidAssignee(ctx, organizationId, input.assigneeId);
    }

    const delegatedToSuperAgent = input.assigneeId === SUPER_AGENT_ASSIGNEE_ID;

    const item = await ctx.storage.taskBoard.create({
      organizationId,
      title: input.title,
      description: input.description ?? null,
      // A task handed to the Super Agent is queued to run — land it in To Do.
      status: delegatedToSuperAgent ? "todo" : input.status,
      priority: input.priority,
      assigneeId: input.assigneeId ?? null,
      assignedBy: input.assigneeId ? getUserId(ctx)! : null,
      dueDate: input.dueDate ?? null,
      columnId: delegatedToSuperAgent ? null : input.columnId,
      tags: input.tags,
      sprintId: input.sprintId ?? null,
      by: getUserId(ctx)!,
    });

    await recordTaskActivity(ctx, {
      organizationId,
      taskBoardItemId: item.id,
      kind: "created",
      actorId: getUserId(ctx)!,
    });

    // Broadcast the new card so every open board adds it live, no polling.
    emitTaskBoardUpdated(organizationId, item);
    const superAgentError = await reactToSuperAgentDelegation(ctx, item);
    // A task created straight into an automated column enqueues its agent.
    if (!delegatedToSuperAgent) {
      await reactToColumnEntry(ctx, item, null);
    }

    return { item, superAgentError: superAgentError ?? undefined };
  },
});
