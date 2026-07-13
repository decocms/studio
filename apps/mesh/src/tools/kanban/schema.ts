import { z } from "zod";

export const KanbanTaskStatusSchema = z.enum([
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "done",
]);

export const KanbanTaskPrioritySchema = z.enum([
  "low",
  "medium",
  "high",
  "urgent",
]);

export const KanbanTaskSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: KanbanTaskStatusSchema,
  priority: KanbanTaskPrioritySchema,
  assigneeId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedBy: z.string(),
  updatedAt: z.string().datetime(),
});
