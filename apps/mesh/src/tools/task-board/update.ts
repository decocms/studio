import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import {
  SUPER_AGENT_ASSIGNEE_ID,
  TaskBoardItemPrioritySchema,
  TaskBoardItemSchema,
  TaskBoardItemStatusSchema,
} from "./schema";
import { assertValidAssignee } from "./validate-assignee";
import { reactToSuperAgentDelegation } from "./enqueue-super-agent";
import { emitTaskBoardUpdated } from "./run-reactions";

export const TASK_BOARD_ITEM_UPDATE = defineTool({
  name: "TASK_BOARD_ITEM_UPDATE",
  description:
    "Update a task board item's fields (title, description, status, priority, assignee), and/or link a chat thread to it.",
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
    /** Link an existing chat thread to this task (many-to-many, idempotent). */
    linkThreadId: z.string().optional(),
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

    if (input.assigneeId) {
      await assertValidAssignee(ctx, organizationId, input.assigneeId);
    }

    // Link an existing chat thread to this task (the "New Chat" flow). Verify
    // the task is this org's before inserting the (idempotent) join row.
    if (input.linkThreadId) {
      const target = await ctx.storage.taskBoard.getById(
        input.id,
        organizationId,
      );
      if (!target) throw new Error(`Task board item not found: ${input.id}`);
      await ctx.storage.taskBoard.linkThread(
        input.id,
        input.linkThreadId,
        organizationId,
      );
    }

    const hasFieldUpdate =
      input.title !== undefined ||
      input.description !== undefined ||
      input.status !== undefined ||
      input.priority !== undefined ||
      input.assigneeId !== undefined ||
      input.dueDate !== undefined;

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

    // A pure link (no field edits) must not bump the task's updated_at — skip
    // the write and re-read the item, now carrying the newly linked thread.
    let item: TaskBoardItem;
    if (hasFieldUpdate) {
      item = await ctx.storage.taskBoard.update(
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
    } else {
      const fetched = await ctx.storage.taskBoard.getById(
        input.id,
        organizationId,
      );
      if (!fetched) throw new Error(`Task board item not found: ${input.id}`);
      item = fetched;
    }

    // Broadcast the delegation flip (assignee + forced To Do), or a new linked
    // thread, so every open board reflects it live. Plain edits already
    // round-trip through the mutation's optimistic patch + invalidate.
    if (becameSuperAgent) {
      emitTaskBoardUpdated(organizationId, item);
      await reactToSuperAgentDelegation(ctx, item);
    } else if (input.linkThreadId) {
      emitTaskBoardUpdated(organizationId, item);
    }

    return { item };
  },
});
