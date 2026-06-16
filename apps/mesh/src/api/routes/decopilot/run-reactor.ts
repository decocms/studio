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
  createDecopilotRunningSummaryEvent,
  createDecopilotStepEvent,
  createDecopilotThreadStatusEvent,
  type RunningThread,
} from "@decocms/mesh-sdk";
import type { StreamBuffer } from "./stream-buffer";
import type { RunningThreadsStore } from "./running-threads-store";
import type { RunEvent, RunTransition } from "./run-state";

// ============================================================================
// Errors
// ============================================================================

// ============================================================================
// Deps
// ============================================================================

export interface RunReactorDeps {
  storage: ThreadStoragePort;
  streamBuffer: StreamBuffer;
  sseHub: { emit(orgId: string, event: SSEEvent): void };
  runningStore: RunningThreadsStore;
}

// Best-effort throughout: the badge must never block or fail a run transition.
async function syncRunningSummary(
  deps: RunReactorDeps,
  orgId: string,
  action: (store: RunningThreadsStore) => Promise<RunningThread[]>,
): Promise<void> {
  try {
    const threads = await action(deps.runningStore);
    deps.sseHub.emit(orgId, createDecopilotRunningSummaryEvent(threads));
  } catch (err) {
    console.error("[run-reactor] running summary sync failed", err);
  }
}

// Fire-and-forget per-user (cross-org) summary on the `user:<id>` channel.
function emitUserRunningSummary(
  deps: RunReactorDeps,
  userId: string | null | undefined,
): void {
  if (!userId) return;
  deps.storage
    .summarizeRunningForUser(userId)
    .then((threads) =>
      deps.sseHub.emit(
        `user:${userId}`,
        createDecopilotRunningSummaryEvent(threads, "user"),
      ),
    )
    .catch((err) =>
      console.error("[run-reactor] user running summary failed", err),
    );
}

// Mark a thread running in the cross-pod store and refresh both summary feeds.
async function markThreadRunning(
  deps: RunReactorDeps,
  orgId: string,
  taskId: string,
  thread:
    | {
        virtual_mcp_id?: string | null;
        title?: string | null;
        created_by?: string | null;
      }
    | null
    | undefined,
): Promise<void> {
  await syncRunningSummary(deps, orgId, (store) =>
    store.markRunning(orgId, {
      id: taskId,
      virtual_mcp_id: thread?.virtual_mcp_id ?? "",
      title: thread?.title ?? null,
      organization_id: orgId,
    }),
  );
  emitUserRunningSummary(deps, thread?.created_by);
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
      title: thread?.title,
      branch: thread?.branch ?? null,
      createdAt: thread?.created_at,
      updatedAt: thread?.updated_at,
    }),
  );
  sseHub.emit(orgId, createDecopilotFinishEvent(taskId, status));
  await syncRunningSummary(deps, orgId, (store) =>
    store.markStopped(orgId, taskId),
  );
  emitUserRunningSummary(deps, thread?.created_by);
}

// ============================================================================
// react — handle a single event
// ============================================================================

async function react(event: RunEvent, deps: RunReactorDeps): Promise<void> {
  const { storage, streamBuffer, sseHub } = deps;

  switch (event.type) {
    case "RUN_STARTED": {
      // Single-execution is guaranteed by the DBOS thread-gate queue
      // (concurrency=1 per threadId partition), so there is no mesh-level
      // run-owner claim to win/lose here — just record the run as active.
      await storage.update(event.taskId, event.orgId, {
        status: "in_progress",
        run_config: event.runConfig ?? null,
        run_started_at: new Date().toISOString(),
      });
      const startedThread = await storage.get(event.taskId, event.orgId);
      sseHub.emit(
        event.orgId,
        createDecopilotThreadStatusEvent(event.taskId, "in_progress", {
          virtualMcpId: startedThread?.virtual_mcp_id ?? undefined,
          createdBy: startedThread?.created_by,
          triggerId: startedThread?.trigger_id,
          title: startedThread?.title,
          branch: startedThread?.branch ?? null,
          createdAt: startedThread?.created_at,
          updatedAt: startedThread?.updated_at,
        }),
      );
      await markThreadRunning(deps, event.orgId, event.taskId, startedThread);
      return;
    }

    case "RUN_RESUMED": {
      await storage.update(event.taskId, event.orgId, {
        run_started_at: new Date().toISOString(),
      });
      const resumedThread = await storage.get(event.taskId, event.orgId);
      sseHub.emit(
        event.orgId,
        createDecopilotThreadStatusEvent(event.taskId, "in_progress", {
          virtualMcpId: resumedThread?.virtual_mcp_id ?? undefined,
          createdBy: resumedThread?.created_by,
          triggerId: resumedThread?.trigger_id,
          title: resumedThread?.title,
          branch: resumedThread?.branch ?? null,
          createdAt: resumedThread?.created_at,
          updatedAt: resumedThread?.updated_at,
        }),
      );
      await markThreadRunning(deps, event.orgId, event.taskId, resumedThread);
      return;
    }

    case "STEP_COMPLETED":
      sseHub.emit(
        event.orgId,
        createDecopilotStepEvent(event.taskId, event.stepCount),
      );
      // Refresh liveness so a long streaming run isn't pruned from the count.
      deps.runningStore.touch(event.orgId, event.taskId).catch(() => {});
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
          run_config: null,
          run_started_at: null,
        });
      } else {
        await storage.update(event.taskId, event.orgId, {
          status: "failed",
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
          title: failedThread?.title,
          branch: failedThread?.branch ?? null,
          createdAt: failedThread?.created_at,
          updatedAt: failedThread?.updated_at,
        }),
      );
      sseHub.emit(
        event.orgId,
        createDecopilotFinishEvent(event.taskId, "failed"),
      );
      await syncRunningSummary(deps, event.orgId, (store) =>
        store.markStopped(event.orgId, event.taskId),
      );
      emitUserRunningSummary(deps, failedThread?.created_by);
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
