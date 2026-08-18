/**
 * Run Reactor — impure shell of the run lifecycle pipeline
 *
 * Every DB write and SSE emit triggered by a run state transition lives
 * here. This is the only layer in the pipeline that performs I/O;
 * decide() and project() are kept pure.
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
} from "@decocms/shared/sdk";
import {
  classifyRunFailure,
  GENERIC_RUN_FAILURE,
} from "./classify-run-failure";
import type { RunEvent, RunFailedReason, RunTransition } from "./run-state";

/** Recorded on a run the idle reaper force-fails for lack of progress. */
const STALL_FAILURE_REASON =
  "Run stalled — no progress within the idle timeout window";

/**
 * What to persist on `threads` for each way a run can fail.
 *
 * Every reason gets one. It used to be `reaped` only, on the theory that the
 * others "are surfaced elsewhere" — they are surfaced only as an error PART, so
 * anything reading the thread row (the board card, the task list, a support
 * query) saw `status: failed` with `failure_reason: ''` and `failure_kind: null`
 * and could not tell a cancel from a crash. `ghost` keeps its bare write: it
 * force-fails a row whose run never existed on this pod, and stamping a reason
 * there would overwrite the real one a concurrent terminal writer just set.
 */
const RUN_FAILURE_RECORD: Record<
  Exclude<RunFailedReason, "ghost">,
  { failure_reason: string; failure_kind: string }
> = {
  reaped: { failure_reason: STALL_FAILURE_REASON, failure_kind: "stall" },
  cancelled: {
    failure_reason: "Run cancelled before it finished",
    failure_kind: "cancelled",
  },
  error: {
    failure_reason: GENERIC_RUN_FAILURE.reason,
    failure_kind: GENERIC_RUN_FAILURE.kind,
  },
};

/**
 * The columns to persist for one failure. Identical to
 * {@link RUN_FAILURE_RECORD} except on the `error` reason, where the run's own
 * error text is classified into a kind that can be grouped by — `credits`,
 * `sandbox_unreachable`, `overloaded`, … — instead of the one generic string
 * every error failure used to share.
 */
function failureRecord(
  reason: Exclude<RunFailedReason, "ghost">,
  errorText: string | null | undefined,
): { failure_reason: string; failure_kind: string } {
  if (reason !== "error") return RUN_FAILURE_RECORD[reason];
  const { kind, reason: text } = classifyRunFailure(errorText);
  return { failure_reason: text, failure_kind: kind };
}

// ============================================================================
// Errors
// ============================================================================

// ============================================================================
// Deps
// ============================================================================

export interface RunReactorDeps {
  storage: ThreadStoragePort;
  sseHub: { emit(orgId: string, event: SSEEvent): void };
  /**
   * The thread just reached a terminal status *because this reactor wrote it*.
   *
   * Every other terminal writer runs the task-board thread-finish pass
   * (advance to In Review + release an unproductive task-quota charge) from
   * its projector wrapper. RUN_FAILED is the one terminal this reactor owns
   * outright — reaped / cancelled / ghost / error force-fails never reach the
   * projector — so without this hook those runs leave the card parked In
   * Progress and the quota charged for a run that produced nothing.
   *
   * Optional so a caller with no board (tests, the desktop path) can omit it.
   */
  onThreadFinished?: (threadId: string, orgId: string) => Promise<void>;
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
  const { storage, sseHub } = deps;
  const thread = await storage.get(taskId, orgId);

  // DB status write intentionally removed: the consume step (consume-run-projection.ts)
  // is now the sole writer for completed/requires_action. The live reactor only emits
  // SSE for instant UX — the durable projector workflow owns the terminal DB transition.
  // (RUN_FAILED below still writes directly, but the projector path now runs
  // unconditionally for both topologies too — so for stream-driven failures that write
  // RACES the projector's `markRunFailed` on the same terminal state. Both sides of
  // that race are now guarded on `in_progress`, so whichever lands first wins and the
  // loser is a no-op; neither can stamp a terminal over an already-settled one. The
  // write here remains the sole DB terminal for desktop pre-publish setup failures
  // (`failPreparedRun`) and for reaped/cancelled/ghost force-fails, which never reach
  // the projector.)
  sseHub.emit(
    orgId,
    createDecopilotThreadStatusEvent(taskId, status, {
      virtualMcpId: thread?.virtual_mcp_id ?? undefined,
      createdBy: thread?.created_by,
      triggerId: thread?.trigger_id,
      title: thread?.title,
      branch: thread?.branch ?? null,
      harnessId: thread?.harness_id ?? undefined,
      createdAt: thread?.created_at,
      updatedAt: thread?.updated_at,
    }),
  );
  sseHub.emit(orgId, createDecopilotFinishEvent(taskId, status));
}

// ============================================================================
// react — handle a single event
// ============================================================================

async function react(event: RunEvent, deps: RunReactorDeps): Promise<void> {
  const { storage, sseHub } = deps;

  switch (event.type) {
    case "RUN_STARTED": {
      // Single-execution is guaranteed by the DBOS thread-gate queue
      // (concurrency=1 per threadId partition), so there is no studio-level
      // run-owner claim to win/lose here — just record the run as active.
      await storage.update(event.taskId, event.orgId, {
        status: "in_progress",
        run_config: event.runConfig ?? null,
        run_started_at: new Date().toISOString(),
        last_progress_at: null,
        // Clear any prior run's recorded failure as this new run starts, so a
        // re-run of a previously-stalled thread doesn't carry a stale reason.
        failure_reason: null,
        failure_kind: null,
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
          harnessId: startedThread?.harness_id ?? undefined,
          createdAt: startedThread?.created_at,
          updatedAt: startedThread?.updated_at,
          messageId: event.messageId,
        }),
      );
      return;
    }

    case "RUN_RESUMED": {
      // A resumed run (DBOS recovery / reaper hand-back) is executing again —
      // flip the thread out of any terminal state a prior force-fail (ghost /
      // reaped) left it in and clear the stale failure, so the UI reflects the
      // running state immediately instead of only at the next FINISH. Mirrors
      // RUN_STARTED, minus run_config (resume keeps the prior run's config).
      // last_progress_at is reset so the stall reaper gives the resumed run a
      // fresh idle window rather than re-reaping it on a stale timestamp.
      await storage.update(event.taskId, event.orgId, {
        status: "in_progress",
        run_started_at: new Date().toISOString(),
        last_progress_at: null,
        failure_reason: null,
        failure_kind: null,
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
          harnessId: resumedThread?.harness_id ?? undefined,
          createdAt: resumedThread?.created_at,
          updatedAt: resumedThread?.updated_at,
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
          event.expectedFenceToken,
        );
        if (!transitioned) return;
        // Clear run columns for ghost failures too
        await storage.update(event.taskId, event.orgId, {
          run_config: null,
          run_started_at: null,
        });
      } else {
        // Guarded on `in_progress`, exactly like every other terminal writer
        // (`markRunFailed`, `completeRunIfNotCompleted`,
        // `requiresActionIfInProgress`). An unguarded write here could stamp
        // `failed` over a run the projector had already settled as
        // `completed` — and it won that race permanently, because the
        // projector's own transitions refuse to overwrite a terminal row.
        const transitioned = await storage.forceFailIfInProgress(
          event.taskId,
          event.orgId,
        );
        if (!transitioned) return;
        await storage.update(event.taskId, event.orgId, {
          run_config: null,
          run_started_at: null,
          ...failureRecord(event.reason, event.errorText),
        });
      }
      // Deliberately NO JetStream purge here. The consume step projects every
      // dispatched run (its entry guard ignores terminal status) and requires
      // the contiguous seq 1..N log; purging on a force-fail beheads a log the
      // producer may still be appending to (reaped-but-alive run, or an
      // in-band failure racing the consume step's read), and the projector
      // then poisons the thread with a persisted "missing seq N" error part.
      // Terminal purge is owned by the projector (runProjectorWorkflowBody);
      // dispatch-start clears the previous turn; max_age bounds the rest.
      const failedThread = await storage.get(event.taskId, event.orgId);
      sseHub.emit(
        event.orgId,
        createDecopilotThreadStatusEvent(event.taskId, "failed", {
          virtualMcpId: failedThread?.virtual_mcp_id ?? undefined,
          createdBy: failedThread?.created_by,
          triggerId: failedThread?.trigger_id,
          title: failedThread?.title,
          branch: failedThread?.branch ?? null,
          harnessId: failedThread?.harness_id ?? undefined,
          createdAt: failedThread?.created_at,
          updatedAt: failedThread?.updated_at,
        }),
      );
      sseHub.emit(
        event.orgId,
        createDecopilotFinishEvent(event.taskId, "failed"),
      );
      // This reactor just became the terminal writer for the run, so it owes
      // the board the same thread-finish pass every other terminal writer does
      // — see `onThreadFinished`. Best-effort: a board/quota failure must not
      // sink the SSE the UI is waiting on, and the hook logs its own errors.
      await deps
        .onThreadFinished?.(event.taskId, event.orgId)
        .catch((err) =>
          console.error("[run-reactor] thread-finish hook failed", err),
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
      // TODO: tracked in https://github.com/decocms/studio/issues — emit a terminal
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
