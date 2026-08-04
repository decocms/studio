import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import type { TaskBoardActivityAction, TaskBoardItem } from "@/storage/types";
import {
  SUPER_AGENT_ASSIGNEE_ID,
  TaskBoardItemPrioritySchema,
  TaskBoardItemSchema,
  TaskBoardItemStatusSchema,
} from "./schema";
import { assertValidAssignee } from "./validate-assignee";
import { reactToSuperAgentDelegation } from "./enqueue-super-agent";
import { recordTaskActivities } from "./activity";
import { emitTaskBoardUpdated } from "./run-reactions";
import {
  ensureTaskExecutionAllowed,
  isReportsTask,
} from "../../billing/task-quota";

/**
 * Fields whose change earns a from/to timeline entry, and the action it logs as.
 * Diffed against the pre-update item, so an edit that doesn't move a field logs
 * nothing. `description` is logged separately, without its values — the
 * timeline records THAT it changed rather than copying a whole body into the
 * log. Deliberately absent: `sortOrder` (drag-to-reorder is noise) and thread
 * links.
 */
const LOGGED_FIELDS: {
  field: "status" | "assigneeId" | "priority" | "dueDate" | "title";
  action: TaskBoardActivityAction;
}[] = [
  { field: "status", action: "status_changed" },
  { field: "assigneeId", action: "assignee_changed" },
  { field: "priority", action: "priority_changed" },
  { field: "dueDate", action: "due_date_changed" },
  { field: "title", action: "title_changed" },
];

/**
 * Which activity entries an update earns, diffed against the pre-update item.
 * Pure — unit-tested — so the one-batched-insert change below can't silently
 * drop or duplicate an entry the old sequential-await version logged.
 */
export function diffTaskActivityEntries(
  previous: TaskBoardItem,
  item: TaskBoardItem,
): { action: TaskBoardActivityAction; data?: Record<string, unknown> }[] {
  const entries: {
    action: TaskBoardActivityAction;
    data?: Record<string, unknown>;
  }[] = [];

  for (const { field, action } of LOGGED_FIELDS) {
    if (item[field] === previous[field]) continue;
    entries.push({ action, data: { from: previous[field], to: item[field] } });
  }

  if (item.description !== previous.description) {
    entries.push({ action: "description_changed" });
  }

  const previousTagIds = new Set(previous.tags.map((t) => t.id));
  const tagsChanged =
    item.tags.length !== previous.tags.length ||
    item.tags.some((t) => !previousTagIds.has(t.id));
  if (tagsChanged) {
    entries.push({
      action: "tags_changed",
      data: { from: previous.tags, to: item.tags },
    });
  }

  return entries;
}

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
    /** Replaces the task's tags with this exact set (org tag ids). */
    tagIds: z.array(z.string()).optional(),
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
      input.sortOrder !== undefined ||
      input.tagIds !== undefined;

    // The pre-update item, used to enqueue only on the transition INTO Super
    // Agent (not on every later edit) and to diff status/assignee for the
    // activity timeline — so fetch it whenever any field changes.
    const previous = hasFieldUpdate
      ? await ctx.storage.taskBoard.getById(input.id, organizationId)
      : null;
    // Proves the task is this org's before the tag write below, which is no
    // longer org-scoped itself (the join table has no organization_id).
    if (hasFieldUpdate && !previous) {
      throw new Error(`Task board item not found: ${input.id}`);
    }
    const assigneeChanged =
      input.assigneeId !== undefined &&
      input.assigneeId !== (previous?.assigneeId ?? null);
    // Delegating a task to the Super Agent queues it to run — force To Do,
    // overriding any status the caller passed alongside the reassignment.
    const becameSuperAgent =
      assigneeChanged && input.assigneeId === SUPER_AGENT_ASSIGNEE_ID;

    if (previous && isReportsTask(previous)) {
      // Reports-pushed tasks are the report's findings — their CONTENT is
      // owned by the reports sync (which refreshes description/priority on
      // open items), so users can't rewrite it. Board interactions stay
      // free: status/drag, assignee (delegating IS how a run starts), due
      // date, tags, thread links.
      if (
        input.title !== undefined ||
        input.description !== undefined ||
        input.priority !== undefined
      ) {
        throw new Error(
          "This task was generated from your report and can't be edited — create your own task instead.",
        );
      }
      // Paywall BEFORE the write: an exhausted quota must not leave the task
      // delegated-but-never-running (the dispatch-side claim would throw
      // after the assignee already persisted).
      if (becameSuperAgent) {
        await ensureTaskExecutionAllowed(ctx, previous);
      }
    }

    // Tags are a separate join table, applied before the item is (re)fetched
    // below so attachTags() picks up the new set either way. Every id must
    // belong to this org — otherwise a caller could attach another org's tag.
    if (input.tagIds !== undefined) {
      const orgTags = await ctx.storage.tags.listOrgTags(organizationId);
      const validTagIds = new Set(orgTags.map((t) => t.id));
      for (const tagId of input.tagIds) {
        if (!validTagIds.has(tagId)) {
          throw new Error(`Tag not found: ${tagId}`);
        }
      }
      await ctx.storage.taskBoard.setItemTags(
        input.id,
        input.tagIds,
        getUserId(ctx)!,
      );
    }

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

    // Log every changed field to the activity timeline in one batched write
    // instead of one sequential DB round-trip per changed field. Best-effort.
    if (previous) {
      const actorId = getUserId(ctx)!;
      const entries = diffTaskActivityEntries(previous, item);
      if (entries.length > 0) {
        await recordTaskActivities(
          ctx,
          entries.map((entry) => ({
            taskBoardItemId: item.id,
            actorId,
            ...entry,
          })),
        );
      }
    }

    // Broadcast EVERY change so open boards reflect it live. Not just the
    // browser's own edits (those also patch optimistically): an agent calling
    // this tool over MCP — e.g. moving its task to In Review — has no client
    // mutation to invalidate, so without this the card only moves on refresh.
    // Same for a teammate's board.
    if (hasFieldUpdate || input.linkThreadId) {
      emitTaskBoardUpdated(organizationId, item);
    }
    if (becameSuperAgent) await reactToSuperAgentDelegation(ctx, item);

    return { item };
  },
});
