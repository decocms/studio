/**
 * Sentinel `assigneeId` for the org's Super Agent (the well-known Decopilot
 * agent). Not a real member userId — `validate-assignee` skips membership for
 * it, and assigning it enqueues a Super Agent run on the task. Lives in
 * `@decocms/shared` so both the server tools and the web board can import it.
 */
export const SUPER_AGENT_ASSIGNEE_ID = "super-agent";

/**
 * Org-scoped SSE event pushed on `sseHub` whenever a Super Agent run advances a
 * task board item's status (enqueued→todo, executing→in_progress, PR→in_review).
 * Its `data` is the full updated `TaskBoardItem`; the web board patches its
 * react-query cache from it, so the board is real-time with no polling.
 */
export const TASK_BOARD_ITEM_UPDATED_EVENT = "task-board.item.updated";

/**
 * Org-scoped SSE event pushed on `sseHub` whenever a task board item is deleted.
 * Its `data` is `{ id }`; the web board drops that item from its react-query
 * cache, so a delete on one client clears the card on every open board.
 */
export const TASK_BOARD_ITEM_DELETED_EVENT = "task-board.item.deleted";
