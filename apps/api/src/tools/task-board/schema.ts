import { z } from "zod";

export { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";

export const TaskBoardItemStatusSchema = z.enum([
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "qa",
  "ready_for_release",
  "deploy",
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
  /** Per-org sequential number — the task's short key. Null only for a legacy
   *  row not yet assigned one. */
  seq: z.number().nullable(),
  /** Custom-column placement; null = derive from `status` (see org board
   *  settings). Always null on the default board. */
  columnId: z.string().nullable(),
  tags: z.array(z.string()),
  sprintId: z.string().nullable(),
  releaseId: z.string().nullable(),
  /** External identity from an importing connector (e.g. `jira:PROJ-123`);
   *  read-only, lets a sync correlate this task back to its source. */
  externalKey: z.string().nullable(),
  // Agent threads linked to this task (many-to-many), most-recent first.
  threads: z.array(TaskBoardItemThreadSchema),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedBy: z.string(),
  updatedAt: z.string().datetime(),
});

export const TaskBoardAttachmentMetaSchema = z.object({
  id: z.string(),
  taskBoardItemId: z.string(),
  commentId: z.string().nullable(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
});

export const TaskBoardCommentSchema = z.object({
  id: z.string(),
  taskBoardItemId: z.string(),
  /** One level of replies — a reply's parentId is a top-level comment id. */
  parentId: z.string().nullable(),
  body: z.string(),
  attachments: z.array(TaskBoardAttachmentMetaSchema),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const TaskBoardSprintStateSchema = z.enum([
  "planned",
  "active",
  "closed",
]);

export const TaskBoardSprintSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: TaskBoardSprintStateSchema,
  startDate: z.string().datetime().nullable(),
  endDate: z.string().datetime().nullable(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
});

export const TaskBoardReleaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
});

const TaskBoardActivityKindSchema = z.enum([
  "created",
  "status_changed",
  "assignee_changed",
  "sprint_changed",
]);

export const TaskBoardActivitySchema = z.object({
  id: z.string(),
  taskBoardItemId: z.string(),
  kind: TaskBoardActivityKindSchema,
  /** User id, or a sentinel ("system" / "super-agent"). */
  actorId: z.string().nullable(),
  /** Event payload, e.g. { from, to } for a status/assignee/sprint change. */
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});

/** Inline upload payload for a new attachment. Size is capped post-decode. */
export const TaskBoardAttachmentUploadSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  /** Base64-encoded file bytes (no data-URL prefix). */
  dataBase64: z.string().min(1),
});

/** 10MB per file — matches the chat attach cap. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
