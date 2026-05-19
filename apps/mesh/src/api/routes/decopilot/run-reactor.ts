/**
 * Run Reactor — impure shell of the run lifecycle pipeline
 *
 * Every DB write, SSE emit, and stream buffer purge triggered by a run
 * state transition lives here. This is the only layer in the pipeline
 * that performs I/O; decide() and project() are kept pure.
 *
 * Consumed via RunRegistry — callers should not use reactAll directly:
 *   registry.execute(command)          — dispatch + react (common case)
 *   registry.react(transitions)        — react only, after inspect-then-react
 */

import type { SSEEvent } from "@/event-bus";
import type { ThreadStoragePort } from "@/storage/ports";
import {
  createDecopilotFinishEvent,
  createDecopilotStepEvent,
  createDecopilotThreadStatusEvent,
} from "@decocms/mesh-sdk";
import type { StreamBuffer } from "./stream-buffer";
import type { RunEvent, RunTransition } from "./run-state";

// ============================================================================
// Errors
// ============================================================================

export class RunClaimError extends Error {
  constructor(taskId: string) {
    super(
      `Failed to claim run for thread ${taskId} — already running on another pod`,
    );
    this.name = "RunClaimError";
  }
}

// ============================================================================
// Deps
// ============================================================================

export interface RunReactorDeps {
  storage: ThreadStoragePort;
  streamBuffer: StreamBuffer;
  sseHub: { emit(orgId: string, event: SSEEvent): void };
}

// ============================================================================
// handleTerminalStatus — shared helper for RUN_COMPLETED / RUN_REQUIRES_ACTION
// ============================================================================

async function handleTerminalStatus(
  taskId: string,
  orgId: string,
  status: "completed" | "requires_action",
  deps: RunReactorDeps,
): Promise<void> {
  const { storage, streamBuffer, sseHub } = deps;
  const thread = await storage.get(taskId, orgId);

  await storage.update(taskId, orgId, {
    status,
    run_owner_pod: null,
    run_config: null,
    run_started_at: null,
  });
  streamBuffer.purge(taskId);
  sseHub.emit(
    orgId,
    createDecopilotThreadStatusEvent(taskId, status, {
      virtualMcpId: thread?.virtual_mcp_id ?? undefined,
      createdBy: thread?.created_by,
      triggerId: thread?.trigger_id,
    }),
  );
  sseHub.emit(orgId, createDecopilotFinishEvent(taskId, status));
}

// ============================================================================
// react — handle a single event
// ============================================================================

async function react(event: RunEvent, deps: RunReactorDeps): Promise<void> {
  const { storage, streamBuffer, sseHub } = deps;

  switch (event.type) {
    case "RUN_STARTED": {
      const claimed = await storage.claimRunStart(
        event.taskId,
        event.orgId,
        {
          status: "in_progress",
          run_owner_pod: event.podId ?? null,
          run_config: event.runConfig ?? null,
          run_started_at: event.podId ? new Date().toISOString() : null,
        },
        event.podId ?? null,
      );
      if (!claimed) {
        throw new RunClaimError(event.taskId);
      }
      const startedThread = await storage.get(event.taskId, event.orgId);
      sseHub.emit(
        event.orgId,
        createDecopilotThreadStatusEvent(event.taskId, "in_progress", {
          virtualMcpId: startedThread?.virtual_mcp_id ?? undefined,
          createdBy: startedThread?.created_by,
          triggerId: startedThread?.trigger_id,
        }),
      );
      return;
    }

    case "RUN_RESUMED": {
      await storage.update(event.taskId, event.orgId, {
        run_owner_pod: event.podId,
        run_started_at: new Date().toISOString(),
      });
      const resumedThread = await storage.get(event.taskId, event.orgId);
      sseHub.emit(
        event.orgId,
        createDecopilotThreadStatusEvent(event.taskId, "in_progress", {
          virtualMcpId: resumedThread?.virtual_mcp_id ?? undefined,
          createdBy: resumedThread?.created_by,
          triggerId: resumedThread?.trigger_id,
        }),
      );
      return;
    }

    case "STEP_COMPLETED":
      sseHub.emit(
        event.orgId,
        createDecopilotStepEvent(event.taskId, event.stepCount),
      );
      return;

    case "RUN_COMPLETED":
      await handleTerminalStatus(event.taskId, event.orgId, "completed", deps);
      return;

    case "RUN_REQUIRES_ACTION":
      await handleTerminalStatus(
        event.taskId,
        event.orgId,
        "requires_action",
        deps,
      );
      return;

    case "RUN_FAILED": {
      // state is undefined post-projection; orgId is carried on the event
      if (event.reason === "ghost") {
        const transitioned = await storage.forceFailIfInProgress(
          event.taskId,
          event.orgId,
        );
        if (!transitioned) return;
        // Clear run columns for ghost failures too
        await storage.update(event.taskId, event.orgId, {
          run_owner_pod: null,
          run_config: null,
          run_started_at: null,
        });
      } else {
        await storage.update(event.taskId, event.orgId, {
          status: "failed",
          run_owner_pod: null,
          run_config: null,
          run_started_at: null,
        });
      }
      streamBuffer.purge(event.taskId);
      const failedThread = await storage.get(event.taskId, event.orgId);
      sseHub.emit(
        event.orgId,
        createDecopilotThreadStatusEvent(event.taskId, "failed", {
          virtualMcpId: failedThread?.virtual_mcp_id ?? undefined,
          createdBy: failedThread?.created_by,
          triggerId: failedThread?.trigger_id,
        }),
      );
      sseHub.emit(
        event.orgId,
        createDecopilotFinishEvent(event.taskId, "failed"),
      );
      return;
    }

    case "PREVIOUS_RUN_ABORTED":
      // The AbortController was already called in RunRegistry.dispatch before
      // projection. The previous run's DB status is overwritten when the
      // subsequent RUN_STARTED event sets it back to in_progress, so audit
      // continuity is preserved. No additional DB write or SSE event is emitted
      // here intentionally — adding one would require a design decision about
      // which status/reason to report.
      // TODO: tracked in https://github.com/decocms/mesh/issues — emit a terminal
      // SSE event and record the interrupted DB row before the new run starts.
      return;
  }
}

// ============================================================================
// reactAll — sequentially process event/state pairs from dispatch()
// ============================================================================

export async function reactAll(
  transitions: RunTransition[],
  deps: RunReactorDeps,
): Promise<void> {
  for (const { event } of transitions) {
    await react(event, deps);
  }
}
