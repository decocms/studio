/**
 * Shared decopilot SSE pool.
 *
 * One ref-counted EventSource per `orgSlug` for `/api/:org/watch` filtered
 * to ALL_DECOPILOT_EVENT_TYPES. Both `useDecopilotEvents` and
 * `ThreadManagerStore` subscribe here so an org only ever holds a single
 * `/watch` connection.
 */

import {
  ALL_DECOPILOT_EVENT_TYPES,
  DECOPILOT_RUNNING_SUMMARY_EVENT,
} from "@decocms/mesh-sdk";
import {
  createSSESubscription,
  type SSESubscription,
} from "./create-sse-subscription";

// The running-summary event is written directly to the stream on connect and
// broadcast on transitions; the client needs a listener registered for its
// type to receive it. Kept separate from the broadcast `ALL_DECOPILOT_EVENT_TYPES`.
const POOL_EVENT_TYPES = [
  ...ALL_DECOPILOT_EVENT_TYPES,
  DECOPILOT_RUNNING_SUMMARY_EVENT,
];

export const decopilotSSE: SSESubscription = createSSESubscription({
  buildUrl: (orgSlug) => {
    const typesParam = POOL_EVENT_TYPES.join(",");
    return `/api/${encodeURIComponent(orgSlug)}/watch?types=${typesParam}`;
  },
  eventTypes: POOL_EVENT_TYPES,
});
