import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import type { TaskBoardActivityKind, TaskBoardItem } from "@/storage/types";
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

/**
 * Fields whose change earns a from/to timeline entry, and the kind it logs as.
 * Diffed against the pre-update item, so an edit that doesn't move a field logs
 * nothing. `description` is logged separately, without its values — the
 * timeline records THAT it changed rather than copying a whole body into the
 * log. Deliberately absent: `sortOrder` (drag-to-reorder is noise) and thread
 * links.
 */
const LOGGED_FIELDS: {
  field: "status" | "assigneeId" | "priority" | "dueDate" | "title";
  kind: TaskBoardActivityKind;
}[] = [
  { field: "status", kind: "status_changed" },
  { field: "assigneeId", kind: "assignee_changed" },
  { field: "priority", kind: "priority_changed" },
  { field: "dueDate", kind: "due_date_changed" },
  { field: "title", kind: "title_changed" },
];

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
      input.sortOrder !== undefined;

    // The pre-update item, used to enqueue only on the transition INTO Super
    // Agent (not on every later edit) and to diff status/assignee for the
    // activity timeline — so fetch it whenever any field changes.
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

    // Log every changed field to the activity timeline. Best-effort.
    if (previous) {
      const actorId = getUserId(ctx)!;
      for (const { field, kind } of LOGGED_FIELDS) {
        if (item[field] === previous[field]) continue;
        await recordTaskActivity(ctx, {
          organizationId,
          taskBoardItemId: item.id,
          kind,
          actorId,
          data: { from: previous[field], to: item[field] },
        });
      }
      if (item.description !== previous.description) {
        await recordTaskActivity(ctx, {
          organizationId,
          taskBoardItemId: item.id,
          kind: "description_changed",
          actorId,
        });
      }
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
