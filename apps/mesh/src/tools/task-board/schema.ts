import { z } from "zod";

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

export const TaskBoardItemSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: TaskBoardItemStatusSchema,
  priority: TaskBoardItemPrioritySchema,
  assigneeId: z.string().nullable(),
  dueDate: z.string().datetime().nullable(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedBy: z.string(),
  updatedAt: z.string().datetime(),
});
