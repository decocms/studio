/**
 * Engine event router.
 *
 * Dispatches a single WorkflowEvent to the appropriate orchestrator handler.
 * Errors inside handlers are caught and (for step.execute) converted into a
 * step-error + step.completed pair so the workflow never stalls. This means
 * the returned promise resolves cleanly — fire-and-forget callers never need
 * a try/catch.
 *
 * This module is engine-internal: hosts call it through
 * `engine.routeEvent(event)` returned by `createWorkflowEngine`.
 *
 * NOTE: fire-and-forget semantics (don't await — let the host's event bus
 * release its lock immediately) live in the host adapter, not here. The
 * engine is transport-agnostic.
 */

import type { WorkflowEvent } from "../ports";
import {
  handleExecutionCreated,
  handleStepCompleted,
  handleStepExecute,
  type OrchestratorContext,
} from "./orchestrator";

export const WORKFLOW_EVENT_TYPES = [
  "workflow.execution.created",
  "workflow.execution.resumed",
  "workflow.step.execute",
  "workflow.step.completed",
] as const;

export function routeEvent(
  event: WorkflowEvent,
  ctx: OrchestratorContext,
): Promise<void> | undefined {
  if (!event.subject) return undefined;

  const executionId = event.subject;
  const data = event.data as Record<string, unknown> | undefined;

  switch (event.type) {
    case "workflow.execution.created":
    case "workflow.execution.resumed":
      return handleExecutionCreated(ctx, executionId).catch((error: Error) => {
        console.error(
          `[WF:event] ${event.type} failed for ${executionId}:`,
          error,
        );
      });

    case "workflow.step.execute":
      if (!data?.stepName) return undefined;
      return handleStepExecute(
        ctx,
        executionId,
        data.stepName as string,
        data.iterationIndex as number | undefined,
      ).catch(async (error: Error) => {
        console.error(
          `[WF:event] step.execute failed for ${executionId}/${data.stepName}:`,
          error,
        );
        const stepId =
          data.iterationIndex !== undefined
            ? `${data.stepName}[${data.iterationIndex}]`
            : (data.stepName as string);
        try {
          await ctx.storage.updateStepResult(executionId, stepId, {
            error: error.message,
            completed_at_epoch_ms: Date.now(),
          });
          await ctx.publish("workflow.step.completed", executionId, {
            stepName: data.stepName as string,
            iterationIndex: data.iterationIndex as number | undefined,
          });
        } catch (publishError) {
          console.error(
            `[WF:event] Failed to publish step.completed error event:`,
            publishError,
          );
        }
      });

    case "workflow.step.completed":
      if (!data?.stepName) return undefined;
      return handleStepCompleted(
        ctx,
        executionId,
        data.stepName as string,
        data.iterationIndex as number | undefined,
      ).catch((error: Error) => {
        console.error(
          `[WF:event] step.completed failed for ${executionId}/${data.stepName}:`,
          error,
        );
      });

    default:
      return undefined;
  }
}

/**
 * Awaitable batch helper used by tests and by the in-process bus adapter.
 * Resolves after every handler has settled.
 */
export async function handleWorkflowEvents(
  events: WorkflowEvent[],
  ctx: OrchestratorContext,
): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const event of events) {
    const p = routeEvent(event, ctx);
    if (p) promises.push(p);
  }
  await Promise.allSettled(promises);
}
