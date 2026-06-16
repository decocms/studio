// `decopilot.*` view of the unified `/watch` pool (watch-sse-pool.ts).
import type { SSESubscription } from "./create-sse-subscription";

import {
  ALL_DECOPILOT_EVENT_TYPES,
  DECOPILOT_RUNNING_SUMMARY_EVENT,
} from "@decocms/mesh-sdk";
import {
  createSSESubscription,
} from "./create-sse-subscription";

// The running-summary snapshot is written directly to the stream on connect
// (not fanned out through the SSE hub), so it never needs server-side type
// filtering — but the client still needs a listener registered for its event
// type to receive it. Hence it's in `eventTypes` but kept separate from the
// broadcast `ALL_DECOPILOT_EVENT_TYPES`.
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
