import {
  handleExecutionCreated,
  handleStepCompleted,
  handleStepExecute,
  type OrchestratorContext,
} from "../engine/orchestrator";

export const WORKFLOW_EVENTS = [
  "workflow.execution.created",
  "workflow.execution.resumed",
  "workflow.step.execute",
  "workflow.step.completed",
] as const;

interface WorkflowEvent {
  type: string;
  data?: unknown;
  subject?: string;
  id: string;
}

/**
 * Route a single workflow event to the appropriate orchestrator handler.
 * Returns a promise that resolves when the handler completes.
 *
 * For step.execute failures, persists the error to DB and publishes
 * a step.completed notification so the workflow doesn't get stuck.
 */
function routeEvent(
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
 * Fire-and-forget handler for production use.
 * Launches all handlers as background tasks without awaiting them,
 * so the event bus worker can release its processing lock immediately.
 */
function fireWorkflowEventHandlers(
  events: WorkflowEvent[],
  ctx: OrchestratorContext,
): void {
  for (const event of events) {
    routeEvent(event, ctx);
  }
}

export { fireWorkflowEventHandlers as handleWorkflowEventsFireAndForget };
