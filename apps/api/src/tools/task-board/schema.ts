import { z } from "zod";

import { SPRINT_STATES } from "@decocms/shared/sprints";
import { REVIEWER_KINDS, type ReviewerKind } from "@decocms/shared/task-board";

export { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";

/** No real task description is this long — caps the row a single write can write. */
export const MAX_TASK_DESCRIPTION_LENGTH = 50_000;

/** No real task title is this long — same reasoning as MAX_TASK_DESCRIPTION_LENGTH,
 *  a title is a one-line label, not a place for the description's content. */
export const MAX_TASK_TITLE_LENGTH = 500;

/** `owner/name` — GitHub caps a login at 39 chars and a repo name at 100,
 *  so nothing legitimate approaches this; same reasoning as the caps above. */
export const MAX_TASK_REPO_LENGTH = 200;

export const TaskBoardItemStatusSchema = z.enum([
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "approved",
  "merged",
  "post_deploy_validation",
  "done",
  "archived",
]);

/**
 * A sprint cards can belong to — mirrored from the tracker the board syncs
 * with (today Jira), never authored here.
 *
 * Shipped alongside the items in `TASK_BOARD_ITEM_LIST` rather than as its own
 * tool: it is the sprint filter's option set, the same way `repos` is the repo
 * filter's, and both are needed exactly when the board loads.
 */
export const SprintSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.enum(SPRINT_STATES),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
});

/**
 * What KIND of work a card is — its shape, not its area.
 *
 * Areas are tags (`SEO`, `Performance`, `Infra`), a card has many of them and
 * exactly one shape. Required — a card always has a type, defaulting to
 * `chore`, the value that asserts the least about work nobody classified.
 */
export const TaskBoardItemTypeSchema = z.enum([
  "bug",
  "feature",
  "chore",
  "spike",
  "security",
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
  /** `threads.failure_kind`, so the board can tell an error from a failure that
   *  is settled history (`superseded`, `ended_after_delivery`). */
  failureKind: z.string().nullable(),
  /** False when the thread was created and never used — see
   *  `shouldAdvanceToReview` for why status alone can't tell. */
  hasMessages: z.boolean(),
  /** USD this run has cost so far; null when the harness recorded none. An
   *  estimate the model provider reported, never a billed amount. */
  costUsd: z.number().nullable(),
  /** Which provider `costUsd` was spent against (e.g. `claude-subscription`,
   *  `openrouter`); null when unrecorded or when the run mixed providers. */
  costProvider: z.string().nullable(),
  createdAt: z.string(),
  /** Newest of the thread's `updated_at` / `last_progress_at` — the stall
   *  reaper's heartbeat, present on every `TaskBoardItemThreadRef`. */
  lastActiveAt: z.string(),
});

/**
 * One reviewer's standing verdict in the task's CURRENT review cycle — what the
 * board card's `1/2` checks indicator counts. Verdicts recorded before the task
 * last entered In Review are stale and never reported; a reviewer that has not
 * decided yet is simply absent from the array.
 *
 * A reviewer's THREAD status can't stand in for this: a review run that reads
 * `completed` may well have asked for changes.
 */
const TaskBoardItemReviewVerdictSchema = z.object({
  reviewer: z.enum(REVIEWER_KINDS as [ReviewerKind]),
  verdict: z.enum(["approved", "changes_requested"]),
  /** Whether the approval was token-verified. An unverified approval counts as
   *  an approval but can never satisfy the auto-merge gate, so it must not
   *  render as a clean pass — see `approvedButUnverified`. */
  verified: z.boolean(),
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
  /** What kind of work this is. Present on every `TaskBoardItem`, so it MUST
   *  be modeled here — see the `retryAttempts` note below on Ajv-revalidating
   *  clients. */
  type: TaskBoardItemTypeSchema,
  assigneeId: z.string().nullable(),
  assignedBy: z.string().nullable(),
  // `owner/name` of the repo (site) this task pertains to.
  repo: z.string().nullable(),
  dueDate: z.string().datetime().nullable(),
  /** The sprint this card belongs to — an id from `TASK_BOARD_ITEM_LIST`'s
   *  `sprints`. Null = backlog. Mirrored from the tracker, not writable here. */
  sprintId: z.string().nullable(),
  // Manual drag-to-reorder position within a lane, ascending.
  sortOrder: z.number(),
  // Per-org sequence behind the card's human key (`DECO-01`); null pre-backfill.
  keySeq: z.number().nullable(),
  // Infrastructure retries already spent on this card's runs — the budget
  // `reactToFailedTaskRun` spends against `MAX_RUN_RETRIES`. Present on every
  // `TaskBoardItem` (see storage/types.ts), so it must be modeled here too:
  // omitting it from this closed object made MCP clients that re-validate
  // `structuredContent` with Ajv (e.g. the studio proxy's `client.callTool`)
  // reject every response with `-32602: Structured content does not match
  // the tool's output schema` the moment a row carried a non-zero value.
  retryAttempts: z.number(),
  // Agent threads linked to this task (many-to-many), most-recent first.
  threads: z.array(TaskBoardItemThreadSchema),
  // Org tags attached to this task, name ascending.
  tags: z.array(TaskBoardItemTagSchema),
  /** Each reviewer's standing verdict in the current review cycle, in
   *  `REVIEWER_KINDS` order; undecided reviewers are absent. Present on every
   *  `TaskBoardItem`, so — like `retryAttempts` above — it MUST be modeled here
   *  or Ajv-revalidating MCP clients reject every response with `-32602`. */
  reviewVerdicts: z.array(TaskBoardItemReviewVerdictSchema),
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
  "merge_failed",
  "type_changed",
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
