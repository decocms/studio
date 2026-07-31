/**
 * Unified `/api/:org/watch` SSE pool. Consumers share ONE cross-tab connection
 * per org that streams the union of their event types; each takes a
 * `filterEventTypes` view of its own.
 */

import { ALL_DECOPILOT_EVENT_TYPES } from "@/sdk";
import {
  TASK_BOARD_COMMENT_AGENT_TYPING_EVENT,
  TASK_BOARD_COMMENT_CREATED_EVENT,
  TASK_BOARD_ITEM_DELETED_EVENT,
  TASK_BOARD_ITEM_UPDATED_EVENT,
} from "@decocms/shared/task-board";
import {
  createSSESubscription,
  filterEventTypes,
  type SSESubscription,
} from "./create-sse-subscription";

/** Every event type multiplexed over the single `/watch` connection. */
const WATCH_TYPES = [
  ...ALL_DECOPILOT_EVENT_TYPES,
  TASK_BOARD_ITEM_UPDATED_EVENT,
  TASK_BOARD_ITEM_DELETED_EVENT,
  TASK_BOARD_COMMENT_CREATED_EVENT,
  TASK_BOARD_COMMENT_AGENT_TYPING_EVENT,
];

/** `?types=` patterns sent to the server. */
const WATCH_URL_TYPES = WATCH_TYPES;

/** Concrete event names the client attaches listeners for. */
const WATCH_EVENT_TYPES = WATCH_TYPES;

/** The single shared, cross-tab `/watch` connection (streams the full union). */
const watchSSE: SSESubscription = createSSESubscription({
  name: "watch",
  buildUrl: (orgSlug) =>
    `/api/${encodeURIComponent(orgSlug)}/watch?types=${WATCH_URL_TYPES.join(",")}`,
  eventTypes: WATCH_EVENT_TYPES,
  crossTab: true,
});

/** Decopilot thread events (step / finish / thread.status). */
export const decopilotWatchView: SSESubscription = filterEventTypes(watchSSE, [
  ...ALL_DECOPILOT_EVENT_TYPES,
]);

/** Task board item lifecycle (`task-board.item.updated` / `.deleted`). */
export const taskBoardWatchView: SSESubscription = filterEventTypes(watchSSE, [
  TASK_BOARD_ITEM_UPDATED_EVENT,
  TASK_BOARD_ITEM_DELETED_EVENT,
]);

/** Comment activity on a task (`task-board.comment.created` / `.agent-typing`). */
export const taskCommentsWatchView: SSESubscription = filterEventTypes(
  watchSSE,
  [TASK_BOARD_COMMENT_CREATED_EVENT, TASK_BOARD_COMMENT_AGENT_TYPING_EVENT],
);
