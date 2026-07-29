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
    tagIds: z.array(z.string()).optional(),
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

    const delegatedToSuperAgent = input.assigneeId === SUPER_AGENT_ASSIGNEE_ID;

    if (input.tagIds?.length) {
      const orgTags = await ctx.storage.tags.listOrgTags(organizationId);
      const validTagIds = new Set(orgTags.map((t) => t.id));
      for (const tagId of input.tagIds) {
        if (!validTagIds.has(tagId)) {
          throw new Error(`Tag not found: ${tagId}`);
        }
      }
    }

    let item = await ctx.storage.taskBoard.create({
      organizationId,
      title: input.title,
      description: input.description ?? null,
      // A task handed to the Super Agent is queued to run — land it in To Do.
      status: delegatedToSuperAgent ? "todo" : input.status,
      priority: input.priority,
      assigneeId: input.assigneeId ?? null,
      assignedBy: input.assigneeId ? getUserId(ctx)! : null,
      dueDate: input.dueDate ?? null,
      by: getUserId(ctx)!,
    });

    if (input.tagIds?.length) {
      await ctx.storage.taskBoard.setItemTags(
        item.id,
        input.tagIds,
        getUserId(ctx)!,
      );
      item = (await ctx.storage.taskBoard.getById(item.id, organizationId))!;
    }

    await recordTaskActivity(ctx, {
      taskBoardItemId: item.id,
      action: "created",
      actorId: getUserId(ctx)!,
    });

    // Broadcast the new card so every open board adds it live, no polling.
    emitTaskBoardUpdated(organizationId, item);
    await reactToSuperAgentDelegation(ctx, item);

    return { item };
  },
});
