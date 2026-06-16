/**
 * Unified `/api/:org/watch` SSE pool. Every consumer (decopilot, workflow,
 * running-summary) shares ONE cross-tab connection per org that streams the
 * union of their event types; each takes a `filterEventTypes` view of its own.
 */

import {
  ALL_DECOPILOT_EVENT_TYPES,
  DECOPILOT_RUNNING_SUMMARY_EVENT,
  DECOPILOT_USER_RUNNING_SUMMARY_EVENT,
} from "@decocms/mesh-sdk";
import {
  createSSESubscription,
  filterEventTypes,
  type SSESubscription,
} from "./create-sse-subscription";

/** Concrete workflow event names emitted on `/watch`. */
const WORKFLOW_EVENT_TYPES = [
  "workflow.execution.created",
  "workflow.execution.resumed",
  "workflow.step.execute",
  "workflow.step.completed",
];

/** Running-summary event names (snapshot-like: cached + replayed to new tabs). */
const RUNNING_SUMMARY_EVENT_TYPES = [
  DECOPILOT_RUNNING_SUMMARY_EVENT,
  DECOPILOT_USER_RUNNING_SUMMARY_EVENT,
];

// Server matches running-summary types by EXACT string (gates a snapshot query),
// so list them verbatim; `workflow.*` is a wildcard the server expands.
const WATCH_URL_TYPES = [
  ...ALL_DECOPILOT_EVENT_TYPES,
  "workflow.*",
  ...RUNNING_SUMMARY_EVENT_TYPES,
];

/** Concrete event names the client attaches listeners for. */
const WATCH_EVENT_TYPES = [
  ...ALL_DECOPILOT_EVENT_TYPES,
  ...WORKFLOW_EVENT_TYPES,
  ...RUNNING_SUMMARY_EVENT_TYPES,
];

/** The single shared, cross-tab `/watch` connection (streams the full union). */
const watchSSE: SSESubscription = createSSESubscription({
  name: "watch",
  buildUrl: (orgSlug) =>
    `/api/${encodeURIComponent(orgSlug)}/watch?types=${WATCH_URL_TYPES.join(",")}`,
  eventTypes: WATCH_EVENT_TYPES,
  stickyTypes: RUNNING_SUMMARY_EVENT_TYPES,
  crossTab: true,
});

/** Decopilot thread events (step / finish / thread.status). */
export const decopilotWatchView: SSESubscription = filterEventTypes(watchSSE, [
  ...ALL_DECOPILOT_EVENT_TYPES,
]);

/** Workflow execution events. */
export const workflowWatchView: SSESubscription = filterEventTypes(
  watchSSE,
  WORKFLOW_EVENT_TYPES,
);

/** Running-summary events (org + per-user scope). */
export const runningSummaryWatchView: SSESubscription = filterEventTypes(
  watchSSE,
  RUNNING_SUMMARY_EVENT_TYPES,
);
