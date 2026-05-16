/**
 * Thread Management Module
 *
 * Public API:
 *   - useThreads(scope, status?)       — read filtered list
 *   - filterThreads(threads, filter)   — client-side post-filter
 *   - useThreadActions()               — write operations
 *   - <ThreadEventsBridge />           — mount once in shell layout
 *
 * Cache contract:
 *   - Two query keys: KEYS.threads(locator, "org") and
 *     KEYS.threads(locator, { kind: "agent", virtualMcpId }).
 *   - Filter dimensions (owner, hasTrigger, userId) are NEVER cache keys.
 *   - SSE events patch rows via setQueriesData; never invalidate.
 *
 * See docs/superpowers/plans/2026-05-14-thread-management-consolidation.md
 * for the migration rationale.
 */

export { useTaskManager } from "./use-task-manager.ts";
export type { Task, ChatMessage } from "./types.ts";
export type { TaskOwnerFilter } from "./use-task-manager.ts";
export { useThreads } from "./thread-store";
export type {
  ThreadScope,
  ThreadStatusFilter,
  UseThreadsResult,
} from "./thread-store";
export { filterThreads } from "./thread-filter";
export type { ThreadFilter } from "./thread-filter";
export { ThreadEventsBridge } from "./thread-events";
export type { RowPatch } from "./thread-events";
export { useThreadActions } from "./thread-actions";
