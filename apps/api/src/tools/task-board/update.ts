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
import { reactToColumnEntry } from "./column-automation";
import { recordTaskActivity } from "./activity";
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
    /** New drag-to-reorder position within its lane (ascending). */
    sortOrder: z.number().optional(),
    /** Custom-column placement (pass together with the column's `status`
     *  stage). Explicit null clears it (derive from status). */
    columnId: z.string().nullable().optional(),
    tags: z.array(z.string().min(1).max(60)).max(20).optional(),
    sprintId: z.string().nullable().optional(),
    releaseId: z.string().nullable().optional(),
    /** Link an existing chat thread to this task (many-to-many, idempotent). */
    linkThreadId: z.string().optional(),
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

    // Link an existing chat thread to this task (the "New Chat" flow). Verify
    // the task AND the thread both belong to this org before inserting the
    // (idempotent) join row — attachThreads() joins task_board_item_threads
    // to threads without an org filter, so an unchecked thread id would let
    // a caller pull another org's thread (title, status, message content)
    // into their own task board.
    if (input.linkThreadId) {
      const target = await ctx.storage.taskBoard.getById(
        input.id,
        organizationId,
      );
      if (!target) throw new Error(`Task board item not found: ${input.id}`);
      const thread = await ctx.storage.threads.get(input.linkThreadId);
      if (!thread) {
        throw new Error(`Thread not found: ${input.linkThreadId}`);
      }
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
      input.dueDate !== undefined ||
      input.sortOrder !== undefined ||
      input.columnId !== undefined ||
      input.tags !== undefined ||
      input.sprintId !== undefined ||
      input.releaseId !== undefined;

    // A column/status move needs the previous placement (automation fires on
    // ENTERING a column); an assignee change needs the previous assignee
    // (enqueue only on the transition INTO Super Agent). The full previous item
    // is also diffed to log status/assignee/sprint changes to the activity
    // timeline — so fetch it whenever any field changes.
    const movesColumn =
      input.status !== undefined || input.columnId !== undefined;
    const previous = hasFieldUpdate
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
          sortOrder: input.sortOrder,
          columnId: becameSuperAgent ? null : input.columnId,
          tags: input.tags,
          sprintId: input.sprintId,
          releaseId: input.releaseId,
          // A human move re-arms column automation for wherever the card
          // lands (the stamp only survives run-driven bounces).
          automationColumnId: movesColumn ? null : undefined,
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

    // Log the meaningful changes to the activity timeline (status, assignee,
    // sprint) by diffing against the pre-update item. Best-effort.
    if (previous) {
      const actorId = getUserId(ctx)!;
      if (item.status !== previous.status) {
        await recordTaskActivity(ctx, {
          organizationId,
          taskBoardItemId: item.id,
          kind: "status_changed",
          actorId,
          data: { from: previous.status, to: item.status },
        });
      }
      if (item.assigneeId !== previous.assigneeId) {
        await recordTaskActivity(ctx, {
          organizationId,
          taskBoardItemId: item.id,
          kind: "assignee_changed",
          actorId,
          data: { from: previous.assigneeId, to: item.assigneeId },
        });
      }
      if (item.sprintId !== previous.sprintId) {
        await recordTaskActivity(ctx, {
          organizationId,
          taskBoardItemId: item.id,
          kind: "sprint_changed",
          actorId,
          data: { from: previous.sprintId, to: item.sprintId },
        });
      }
    }

    // Broadcast the delegation flip (assignee + forced To Do), or a new linked
    // thread, so every open board reflects it live. Plain edits already
    // round-trip through the mutation's optimistic patch + invalidate.
    let superAgentError: string | null = null;
    if (becameSuperAgent) {
      emitTaskBoardUpdated(organizationId, item);
      superAgentError = await reactToSuperAgentDelegation(ctx, item);
    } else if (input.linkThreadId) {
      emitTaskBoardUpdated(organizationId, item);
    }

    // A human column/status move may land the task in an automated column.
    if (!becameSuperAgent && movesColumn && previous) {
      await reactToColumnEntry(ctx, item, {
        status: previous.status,
        columnId: previous.columnId,
      });
    }

    return { item, superAgentError: superAgentError ?? undefined };
  },
});
