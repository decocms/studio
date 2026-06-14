/**
 * Shared telos SSE pool.
 *
 * One ref-counted EventSource per `orgSlug` for `/api/:org/watch` filtered to
 * the telos notification events. Lets the home subscribe for live goal/fact
 * updates instead of polling. EventSource listens to named events, so the
 * concrete type list is enumerated here (no client-side wildcard).
 */

import {
  createSSESubscription,
  type SSESubscription,
} from "./create-sse-subscription";

const TELOS_SSE_EVENT_TYPES = [
  "telos.goal.installed",
  "telos.facts.updated",
] as const;

export const telosSSE: SSESubscription = createSSESubscription({
  buildUrl: (orgSlug) =>
    `/api/${encodeURIComponent(orgSlug)}/watch?types=${TELOS_SSE_EVENT_TYPES.join(",")}`,
  eventTypes: [...TELOS_SSE_EVENT_TYPES],
});
