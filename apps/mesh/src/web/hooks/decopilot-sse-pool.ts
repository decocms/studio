/**
 * Shared decopilot SSE pool.
 *
 * One ref-counted EventSource per `orgSlug` for `/api/:org/watch` filtered
 * to ALL_DECOPILOT_EVENT_TYPES. Both `useDecopilotEvents` and
 * `ThreadManagerStore` subscribe here so an org only ever holds a single
 * `/watch` connection.
 */

import { ALL_DECOPILOT_EVENT_TYPES } from "@decocms/mesh-sdk";
import {
  createSSESubscription,
  type SSESubscription,
} from "./create-sse-subscription";

export const decopilotSSE: SSESubscription = createSSESubscription({
  buildUrl: (orgSlug) => {
    const typesParam = ALL_DECOPILOT_EVENT_TYPES.join(",");
    return `/api/${encodeURIComponent(orgSlug)}/watch?types=${typesParam}`;
  },
  eventTypes: [...ALL_DECOPILOT_EVENT_TYPES],
});
