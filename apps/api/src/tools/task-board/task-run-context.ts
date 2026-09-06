/**
 * The run a task-board MCP request belongs to.
 *
 * The sandbox-hosted harness reaches Studio over HTTP at
 * `/api/<slug>/mcp/task-run/<threadId>`, so the run it is serving is in the URL
 * — not in any tool's input. That is deliberate: the per-run API key is minted
 * with full access, so a `threadId` argument would let a run act on another
 * run's sandbox. The route puts the path value here; `TASK_ADD_REPO` reads it.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolName } from "@decocms/shared/tools/registry-metadata";
import type { ThreadMetadata } from "@decocms/shared/entities";
import {
  isReviewerThreadTitle,
  REVIEWER_KINDS,
} from "@decocms/shared/task-board";

export interface TaskRunContext {
  /** The run thread this MCP session belongs to. */
  threadId: string;
}

export const taskRunContextStore = new AsyncLocalStorage<TaskRunContext>();

export function requireTaskRunContext(): TaskRunContext {
  const ctx = taskRunContextStore.getStore();
  if (!ctx) {
    throw new Error(
      "This tool is only available on a task run's MCP endpoint " +
        "(/api/<org>/mcp/task-run/<threadId>).",
    );
  }
  return ctx;
}

/**
 * The tools a task run's MCP endpoint exposes.
 *
 * A narrow surface, not the whole management catalog: the harness used to get
 * every Studio tool (~200) and had to find the two it needed in that list.
 *
 * Deliberately absent: creating and deleting tasks, `TASK_BOARD_REVIEW_DECISION`
 * and `TASK_BOARD_PROMOTE_TO_PRODUCTION` — an agent must not approve or merge
 * its own work. A REVIEWER's run is a different run on a different thread, and
 * gets `REVIEW_RUN_TOOL_NAMES` below.
 */
export const TASK_RUN_TOOL_NAMES: readonly ToolName[] = [
  "TASK_ADD_REPO",
  "TASK_BOARD_ITEM_LIST",
  "TASK_BOARD_ITEM_UPDATE",
  "TASK_BOARD_ACTIVITY_LIST",
  "TASK_BOARD_COMMENT_LIST",
  "TASK_BOARD_COMMENT_CREATE",
  "TASK_BOARD_COMMENT_UPDATE",
];

/**
 * The same surface plus `TASK_BOARD_REVIEW_DECISION`, for a REVIEWER's run.
 *
 * A reviewer is told "end the run by calling `TASK_BOARD_REVIEW_DECISION`" — it
 * has to actually have it. It didn't: reviewer runs went out on Decopilot, which
 * aggregates no connections, so every review ended with `enable_tool` answering
 * `not_found` for both this and `TASK_BOARD_ITEM_PRS_GET`. Reviewers did the
 * whole review, reached a verdict, and had no way to record it — the task then
 * sat In Review forever.
 *
 * Still keyed to the run: `resolveReviewRunToolNames` hands this list out only
 * for a thread the board created as a reviewer thread, so the invariant above
 * ("an agent must not approve its own work") holds — a Super Agent run's own
 * endpoint never serves it.
 */
export const REVIEW_RUN_TOOL_NAMES: readonly ToolName[] = [
  ...TASK_RUN_TOOL_NAMES,
  // The PR under review. Reviewer-only: a Super Agent run works on the branch
  // it was given and never needs to look its own pull request up — the board
  // does that for it now (`pr-by-branch.ts`).
  "TASK_BOARD_ITEM_PRS_GET",
  "TASK_BOARD_REVIEW_DECISION",
];

/**
 * The surface for a run the Jira integration started: the issue's tools, and
 * NONE of the board's. The card behind such a run is only its anchor, and a
 * board tool there would let the agent "update the task" on a card nobody
 * reads instead of the issue everybody does.
 */
export const JIRA_RUN_TOOL_NAMES: readonly ToolName[] = [
  "TASK_ADD_REPO",
  "JIRA_ISSUE_GET",
  "JIRA_COMMENT_ADD",
  "JIRA_ISSUE_TRANSITION",
  "JIRA_ATTACHMENT_DOWNLOAD",
];

/**
 * Which tool surface a task-run MCP session gets, from the run thread.
 *
 * A Jira-triggered run is stamped in its metadata at dispatch. A reviewer is
 * told apart by the title, which is how the rest of the board already tells a
 * reviewer thread from a Super Agent one (`isReviewerThreadTitle`,
 * `"Super Agent:"` in `enqueueReviewersOnThreadFinish`). A missing thread
 * falls back to the narrow list.
 */
export function resolveTaskRunToolNames(
  thread:
    | { title?: string | null; metadata?: ThreadMetadata | null }
    | null
    | undefined,
): readonly ToolName[] {
  if (thread?.metadata?.source === "jira") return JIRA_RUN_TOOL_NAMES;
  const isReviewer = REVIEWER_KINDS.some((kind) =>
    isReviewerThreadTitle(thread?.title, kind),
  );
  return isReviewer ? REVIEW_RUN_TOOL_NAMES : TASK_RUN_TOOL_NAMES;
}
