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
  "TASK_BOARD_ITEM_PRS_GET",
  "TASK_BOARD_ITEM_PR_LINK",
  "TASK_BOARD_ACTIVITY_LIST",
  "TASK_BOARD_COMMENT_LIST",
  "TASK_BOARD_COMMENT_CREATE",
  "TASK_BOARD_COMMENT_UPDATE",
];

/**
 * The same surface plus `TASK_BOARD_REVIEW_DECISION` and `TAKE_SCREENSHOT`, for
 * a REVIEWER's run.
 *
 * `TAKE_SCREENSHOT` is here and not in `TASK_RUN_TOOL_NAMES` because it exists
 * for the QA reviewer, which must exercise the PR's deploy preview and show
 * what it saw. The sandbox has no browser (deliberately — see the tool's own
 * comment), so the capture happens Studio-side.
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
  "TASK_BOARD_REVIEW_DECISION",
  "TAKE_SCREENSHOT",
];

/**
 * Which tool surface a task-run MCP session gets, from the run thread's title.
 *
 * The title is how the rest of the board already tells a reviewer thread from a
 * Super Agent one (`isReviewerThreadTitle`, `"Super Agent:"` in
 * `enqueueReviewersOnThreadFinish`) — reusing it keeps one discriminator rather
 * than adding a column. A missing thread falls back to the narrow list.
 */
export function resolveReviewRunToolNames(
  title: string | null | undefined,
): readonly ToolName[] {
  const isReviewer = REVIEWER_KINDS.some((kind) =>
    isReviewerThreadTitle(title, kind),
  );
  return isReviewer ? REVIEW_RUN_TOOL_NAMES : TASK_RUN_TOOL_NAMES;
}
