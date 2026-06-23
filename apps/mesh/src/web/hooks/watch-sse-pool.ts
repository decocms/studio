/**
 * Unified `/api/:org/watch` SSE pool. Consumers share ONE cross-tab connection
 * per org that streams the union of their event types; each takes a
 * `filterEventTypes` view of its own.
 */

import { ALL_DECOPILOT_EVENT_TYPES } from "@decocms/mesh-sdk";
import {
  createSSESubscription,
  filterEventTypes,
  type SSESubscription,
} from "./create-sse-subscription";

/** `?types=` patterns sent to the server. */
const WATCH_URL_TYPES = [...ALL_DECOPILOT_EVENT_TYPES];

/** Concrete event names the client attaches listeners for. */
const WATCH_EVENT_TYPES = [...ALL_DECOPILOT_EVENT_TYPES];

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
