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
 * its own work.
 */
export const TASK_RUN_TOOL_NAMES: readonly ToolName[] = [
  "TASK_ADD_REPO",
  "TASK_BOARD_ITEM_LIST",
  "TASK_BOARD_ITEM_UPDATE",
  "TASK_BOARD_ITEM_PRS_GET",
  "TASK_BOARD_ACTIVITY_LIST",
  "TASK_BOARD_COMMENT_LIST",
  "TASK_BOARD_COMMENT_CREATE",
  "TASK_BOARD_COMMENT_UPDATE",
];
