import { z } from "zod";

export { SUPER_AGENT_ASSIGNEE_ID } from "@/shared/task-board";

export const TaskBoardItemStatusSchema = z.enum([
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "done",
]);

export const TaskBoardItemPrioritySchema = z.enum([
  "low",
  "medium",
  "high",
  "urgent",
]);

/** A thread linked to a task, with the live run state the board renders. */
export const TaskBoardItemThreadSchema = z.object({
  threadId: z.string(),
  virtualMcpId: z.string().nullable(),
  status: z
    .enum(["in_progress", "requires_action", "failed", "completed", "expired"])
    .nullable(),
  title: z.string().nullable(),
  lastMessage: z.string().nullable(),
  hasPreview: z.boolean(),
  createdAt: z.string(),
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
  // Agent threads linked to this task (many-to-many), most-recent first.
  threads: z.array(TaskBoardItemThreadSchema),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedBy: z.string(),
  updatedAt: z.string().datetime(),
});
