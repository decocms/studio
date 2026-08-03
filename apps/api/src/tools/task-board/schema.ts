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

/** A tag attached to a task, plus who attached it and when. */
const TaskBoardItemTagSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable().describe('Hex color, e.g. "#3b82f6"'),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
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
  /** GitHub's mergeability for the PR: `false` means it conflicts with its base
   *  branch and can't be merged; `true` means it's clean. `null` when GitHub
   *  hasn't computed it yet (it's async) or the fetch failed — an unknown must
   *  never be read as "conflict". */
  mergeable: z.boolean().nullable(),
  /** Combined CI check state for the PR's head commit, fetched live from GitHub.
   *  `null` when the PR has no checks or the fetch failed. Best-effort — reads
   *  the combined Status API, so a repo that only uses the Checks API may report
   *  `null` even while check runs are in flight. */
  checksStatus: z.enum(["pending", "passing", "failing"]).nullable(),
  /** The PR's individual CI checks (name/conclusion/details link), for the
   *  card's expandable checks footer. `summary` is the check's output markdown,
   *  present only for failing checks. */
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      detailsUrl: z.string().nullable(),
      summary: z.string().nullable(),
    }),
  ),
  /** deco.cx deploy preview URL for the PR, lifted from a deploy status posted
   *  on the head commit. `null` when the site posts no such status. */
  previewUrl: z.string().nullable(),
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
  // Org tags attached to this task, name ascending.
  tags: z.array(TaskBoardItemTagSchema),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedBy: z.string(),
  updatedAt: z.string().datetime(),
});

/**
 * Every action the activity log accepts — the single source of truth. The
 * `TaskBoardActivityAction` union and the zod enum below both derive from it,
 * and `activity-actions.test.ts` asserts the newest migration's CHECK
 * constraint allows exactly this set. Adding an action: extend this list, add
 * a migration replacing the constraint, handle it in the dialog's switch (the
 * compiler will insist).
 */
export const TASK_BOARD_ACTIVITY_ACTIONS = [
  "created",
  "status_changed",
  "assignee_changed",
  "priority_changed",
  "due_date_changed",
  "title_changed",
  "description_changed",
  "tags_changed",
  "review_requested",
  "review_approved",
  "review_changes_requested",
  "merge_conflict_resolution",
] as const;

export type TaskBoardActivityAction =
  (typeof TASK_BOARD_ACTIVITY_ACTIONS)[number];

const TaskBoardActivityActionSchema = z.enum(TASK_BOARD_ACTIVITY_ACTIONS);

/** One entry in a task's change timeline — who did what, when. */
export const TaskBoardActivitySchema = z.object({
  id: z.string(),
  taskBoardItemId: z.string(),
  action: TaskBoardActivityActionSchema,
  /** The member who did it; null when the agent/system did. */
  actorId: z.string().nullable(),
  /** Event payload, e.g. { from, to } for a status/assignee change. */
  data: z.record(z.string(), z.unknown()),
  occurredAt: z.string().datetime(),
});
