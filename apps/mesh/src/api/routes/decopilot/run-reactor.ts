/**
 * Run Reactor — side-effect handler for run lifecycle events
 *
 * Every DB write, SSE emit, and stream buffer purge triggered by a run
 * state transition lives here. The reactor is the only place in the
 * decopilot pipeline that performs I/O in response to run events.
 *
 * Usage:
 *   const pairs = runRegistry.dispatch(command);
 *   await reactAll(pairs, deps);
 */

import type { SSEEvent } from "@/event-bus";
import type { ThreadStoragePort } from "@/storage/ports";
import {
  createDecopilotFinishEvent,
  createDecopilotStepEvent,
  createDecopilotThreadStatusEvent,
} from "@decocms/mesh-sdk";
import type { StreamBuffer } from "./stream-buffer";
import type { RunEvent, RunEventPair, RunState } from "./run-state";

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
  threadId: string,
  orgId: string,
  status: "completed" | "requires_action",
  deps: RunReactorDeps,
): Promise<void> {
  const { storage, streamBuffer, sseHub } = deps;
  await storage.update(threadId, { status });
  streamBuffer.purge(threadId);
  sseHub.emit(orgId, createDecopilotThreadStatusEvent(threadId, status));
  sseHub.emit(orgId, createDecopilotFinishEvent(threadId, status));
}

// ============================================================================
// react — handle a single event
// ============================================================================

async function react(
  event: RunEvent,
  state: RunState | undefined,
  deps: RunReactorDeps,
): Promise<void> {
  const { storage, streamBuffer, sseHub } = deps;

  switch (event.type) {
    case "RUN_STARTED":
      await storage.update(event.threadId, { status: "in_progress" });
      sseHub.emit(
        event.orgId,
        createDecopilotThreadStatusEvent(event.threadId, "in_progress"),
      );
      return;

    case "STEP_COMPLETED":
      // state is post-projection running state; orgId lives on RunState root
      if (state?.orgId) {
        sseHub.emit(
          state.orgId,
          createDecopilotStepEvent(event.threadId, event.stepCount),
        );
      }
      return;

    case "RUN_COMPLETED":
      await handleTerminalStatus(
        event.threadId,
        event.orgId,
        "completed",
        deps,
      );
      return;

    case "RUN_REQUIRES_ACTION":
      await handleTerminalStatus(
        event.threadId,
        event.orgId,
        "requires_action",
        deps,
      );
      return;

    case "RUN_FAILED": {
      // state is undefined post-projection; orgId is carried on the event
      if (event.reason === "ghost") {
        await storage.forceFailIfInProgress(event.threadId);
      } else {
        await storage.update(event.threadId, { status: "failed" });
      }
      streamBuffer.purge(event.threadId);
      sseHub.emit(
        event.orgId,
        createDecopilotThreadStatusEvent(event.threadId, "failed"),
      );
      sseHub.emit(
        event.orgId,
        createDecopilotFinishEvent(event.threadId, "failed"),
      );
      return;
    }

    case "PREVIOUS_RUN_ABORTED":
      // The AbortController was already called in RunRegistry.dispatch before
      // projection. The previous run's DB status is overwritten when the
      // subsequent RUN_STARTED event sets it back to in_progress, so audit
      // continuity is preserved. No additional DB write or SSE event is emitted
      // here intentionally — adding one would require a design decision about
      // which status/reason to report and is deferred to a follow-up.
      return;
  }
}

// ============================================================================
// reactAll — sequentially process event/state pairs from dispatch()
// ============================================================================

export async function reactAll(
  pairs: RunEventPair[],
  deps: RunReactorDeps,
): Promise<void> {
  for (const { event, state } of pairs) {
    await react(event, state, deps);
  }
}
