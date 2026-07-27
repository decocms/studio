import { z } from "zod";

export { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";

export const TaskBoardItemStatusSchema = z.enum([
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "done",
]);

export const TaskBoardItemPrioritySchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "urgent",
]);

/** A thread linked to a task, with the live run state the board renders. */
const TaskBoardItemThreadSchema = z.object({
  threadId: z.string(),
  virtualMcpId: z.string().nullable(),
  status: z
    .enum(["in_progress", "requires_action", "failed", "completed", "expired"])
    .nullable(),
  title: z.string().nullable(),
  lastMessage: z.string().nullable(),
  hasPreview: z.boolean(),
  /** False when the thread was created and never used — see
   *  `shouldAdvanceToReview` for why status alone can't tell. */
  hasMessages: z.boolean(),
  createdAt: z.string(),
});

/** A GitHub PR linked to a task. Identity is persisted; title/body/state/draft/
 *  merged are fetched live from GitHub and are null when that fetch failed. */
export const TaskBoardItemPrSchema = z.object({
  url: z.string(),
  number: z.number(),
  repoOwner: z.string(),
  repoName: z.string(),
  createdAt: z.string(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]).nullable(),
  draft: z.boolean().nullable(),
  merged: z.boolean().nullable(),
});

export const TaskBoardItemSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: TaskBoardItemStatusSchema,
  priority: TaskBoardItemPrioritySchema,
  assigneeId: z.string().nullable(),
  assignedBy: z.string().nullable(),
  dueDate: z.string().datetime().nullable(),
  // Manual drag-to-reorder position within a lane, ascending.
  sortOrder: z.number(),
  // Agent threads linked to this task (many-to-many), most-recent first.
  threads: z.array(TaskBoardItemThreadSchema),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedBy: z.string(),
  updatedAt: z.string().datetime(),
});
