/**
 * Mesh-side event delivery for the workflow engine.
 *
 * The mesh delivers each event batch with a per-org publish/createMCPProxy
 * already bound (via ServerPluginEventContext). So instead of using the
 * engine's createWorkflowEngine factory (which assumes stable ports),
 * this adapter builds an OrchestratorContext per batch and calls the
 * engine's routeEvent directly.
 *
 * Fire-and-forget: handlers run in the background so the event bus worker
 * can release its processing lock immediately. routeEvent's promise never
 * rejects — errors get converted into step-error + step.completed pairs.
 */

import {
  routeEvent,
  WORKFLOW_EVENT_TYPES,
  type OrchestratorContext,
  type WorkflowEvent,
} from "@decocms/workflow-engine";

export const WORKFLOW_EVENTS = WORKFLOW_EVENT_TYPES;

export function handleWorkflowEventsFireAndForget(
  events: WorkflowEvent[],
  ctx: OrchestratorContext,
): void {
  for (const event of events) {
    void routeEvent(event, ctx);
  }
}
