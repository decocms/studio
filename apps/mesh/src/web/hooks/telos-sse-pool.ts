// One ref-counted EventSource per org over /api/:org/watch, filtered to the telos
// notification types (EventSource listens to named events, so they're enumerated).

import {
  createSSESubscription,
  type SSESubscription,
} from "./create-sse-subscription";

const TELOS_SSE_EVENT_TYPES = [
  "telos.goal.installed",
  "telos.facts.updated",
  "telos.goal.suggestion",
  "telos.goal.thought",
] as const;

export const telosSSE: SSESubscription = createSSESubscription({
  buildUrl: (orgSlug) =>
    `/api/${encodeURIComponent(orgSlug)}/watch?types=${TELOS_SSE_EVENT_TYPES.join(",")}`,
  eventTypes: [...TELOS_SSE_EVENT_TYPES],
});
