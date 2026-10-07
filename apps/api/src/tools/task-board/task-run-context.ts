/**
 * The run a thread MCP request belongs to.
 *
 * The sandbox-hosted harness reaches Studio over HTTP at
 * `/api/<slug>/mcp/thread/<threadId>`, so the run it is serving is in the URL
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
      "This tool is only available on a thread's MCP endpoint " +
        "(/api/<org>/mcp/thread/<threadId>).",
    );
  }
  return ctx;
}

/**
 * The tools a task run reports its work through — the base of every surface
 * but Jira's.
 *
 * A narrow surface, not the whole management catalog: the harness used to get
 * every Studio tool (~200) and had to find the two it needed in that list.
 *
 * Deliberately absent: `TASK_BOARD_REVIEW_DECISION` and
 * `TASK_BOARD_PROMOTE_TO_PRODUCTION` — an agent must not approve or merge its
 * own work. A REVIEWER's run is a different run on a different thread, and
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
  "JIRA_REMOTE_LINK_ADD",
  "JIRA_ISSUE_CREATE",
  "JIRA_ISSUE_SEARCH",
];

/**
 * What every chat's endpoint serves: the task-run surface (a chat clones a repo
 * with `TASK_ADD_REPO`, which replaced `load_repo`), plus what Decopilot chats
 * had as built-ins.
 *
 * Deliberately absent: `TASK_BOARD_REVIEW_DECISION` and
 * `TASK_BOARD_PROMOTE_TO_PRODUCTION` (an agent must not approve its own work),
 * and the board prompt/automation writes, which Decopilot only ran behind an
 * approval this path does not have.
 */
export const THREAD_TOOL_NAMES: readonly ToolName[] = [
  ...TASK_RUN_TOOL_NAMES,
  "generate_image",
  "web_search",
  "deep_research",
  "suggest_task",
  "update_interests",
  "COLLECTION_THREADS_LIST",
  "COLLECTION_THREADS_GET",
  "COLLECTION_THREAD_MESSAGES_LIST",
  "TASK_BOARD_ITEM_CREATE",
  "TASK_BOARD_ITEM_DELETE",
  "TASK_BOARD_ITEM_PRS_GET",
  "TASK_BOARD_PROMPT_LIST",
  "TASK_BOARD_AUTOMATION_LIST",
  "TASK_BOARD_ADMIN_ORG_LIST",
  "TASK_BOARD_DELIVERY",
  "TASK_BOARD_STUCK",
  "TASK_BOARD_COST",
  "TASK_BOARD_QUALITY",
  "TASK_BOARD_ERRORS",
  "TASK_BOARD_TENANTS",
  "COLLECTION_VIRTUAL_MCP_CREATE",
  "COLLECTION_VIRTUAL_MCP_LIST",
  "COLLECTION_VIRTUAL_MCP_GET",
  "COLLECTION_VIRTUAL_MCP_UPDATE",
  "COLLECTION_VIRTUAL_MCP_DELETE",
  "COLLECTION_CONNECTIONS_LIST",
  "COLLECTION_CONNECTIONS_GET",
];

/**
 * Tools a run gets because of what the run IS, not because of who dispatched
 * it — the run's key carries them whatever the dispatcher's role. Everything
 * else a thread serves is bounded by the dispatcher's own grants.
 */
export const RUN_SCOPED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...TASK_RUN_TOOL_NAMES,
  ...REVIEW_RUN_TOOL_NAMES,
  ...JIRA_RUN_TOOL_NAMES,
]);

/**
 * Which tool surface a thread's MCP session gets, from the thread.
 *
 * A Jira-triggered run is stamped in its metadata at dispatch. A reviewer is
 * told apart by the title, which is how the rest of the board already tells a
 * reviewer thread from a Super Agent one (`isReviewerThreadTitle`). Every other
 * thread — a chat, or a Super Agent task run — gets the chat surface, which
 * includes the task-run tools. A missing thread gets it too: the route is
 * org-scoped, so a foreign thread id finds nothing to act on.
 */
export function resolveThreadToolNames(
  thread:
    | { title?: string | null; metadata?: ThreadMetadata | null }
    | null
    | undefined,
): readonly ToolName[] {
  if (thread?.metadata?.source === "jira") return JIRA_RUN_TOOL_NAMES;
  const isReviewer = REVIEWER_KINDS.some((kind) =>
    isReviewerThreadTitle(thread?.title, kind),
  );
  return isReviewer ? REVIEW_RUN_TOOL_NAMES : THREAD_TOOL_NAMES;
}
