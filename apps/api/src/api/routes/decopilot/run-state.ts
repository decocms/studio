/**
 * Run Lifecycle — Command/Dispatch/React Pipeline
 *
 * This is NOT event sourcing. Events are ephemeral and not persisted.
 * The architecture is "functional core / imperative shell":
 *
 *   Command (intent)
 *     ↓  decide(command, state) → events[]       [pure, sync, testable]
 *   Events (facts)
 *     ↓  project(state, event) → newState        [pure, sync, testable]
 *   New State
 *     ↓  react(event, state, deps) → Promise     [impure, all I/O here]
 *   Side Effects (DB, SSE, AbortController)
 *
 * Rules:
 *   1. decide()  — no I/O, no async, no app imports. Returns events or [] if
 *                  the command is invalid for the current state.
 *   2. project() — no I/O. Returns undefined to evict a run (terminal states).
 *                  State returned here is the post-event state.
 *   3. react()   — only layer that touches DB, SSE, or streams.
 *   4. RunRegistry.dispatch() is the only entry point for state mutations.
 *      RunRegistry.execute() is the convenience wrapper (dispatch + react).
 *      Never mutate states directly.
 *   5. AbortController.abort() fires inside dispatch (before projection),
 *      not in the reactor — abort is synchronous and must happen before eviction.
 *
 * Adding a new command: define the type below, add a case in decide(), handle
 * new events in project() and react(). Tests for decide and project are pure
 * and fast — write them first.
 *
 * No imports from app code — safe to import anywhere.
 */

// ============================================================================
// Status
// ============================================================================

export type RunFailedReason = "cancelled" | "error" | "reaped" | "ghost";

export type RunStatus = {
  tag: "running";
  abortController: AbortController;
  stepCount: number;
  startedAt: Date;
};

export interface RunState {
  taskId: string;
  orgId: string;
  userId: string;
  status: RunStatus;
}

// ============================================================================
// Commands
// ============================================================================

export type RunCommand =
  | {
      type: "START";
      taskId: string;
      orgId: string;
      userId: string;
      /** Caller creates the AbortController so the decider stays truly pure */
      abortController: AbortController;
      /** Opaque run config for persistence. run-state.ts must never import the concrete type. */
      runConfig?: Record<string, unknown>;
      /** Pod claiming this run. */
      podId?: string;
      /** The user message this turn executes — rides the in_progress thread-status event so the queue tray can flip exactly this item into the body at dispatch. */
      messageId?: string;
    }
  | {
      type: "RESUME";
      taskId: string;
      orgId: string;
      userId: string;
      abortController: AbortController;
      podId: string;
    }
  | { type: "STEP_DONE"; taskId: string }
  | {
      type: "FINISH";
      taskId: string;
      threadStatus: "completed" | "failed" | "requires_action";
      /** The failure's error text, when there is one — classified into a
       *  `failure_kind` by the reactor. Omitted for a clean finish. */
      errorText?: string | null;
    }
  | { type: "CANCEL"; taskId: string }
  | {
      type: "FORCE_FAIL";
      taskId: string;
      reason: "ghost";
      /**
       * Required for ghost commands — the server restarted and there is no
       * in-memory state to derive orgId from.
       */
      orgId: string;
      /**
       * The run fence token current when this cancel was issued. Scopes the
       * force-fail to that specific turn so a follow-up turn (fresh fence) sent
       * while the cancel is still settling is never clobbered. Omitted →
       * unconditional force-fail (legacy).
       */
      expectedFenceToken?: string | null;
    }
  | {
      type: "FORCE_FAIL";
      taskId: string;
      reason: "reaped";
      /** orgId is read from the existing RunState; must not be supplied. */
      orgId?: never;
    };

// ============================================================================
// Events
// ============================================================================

export type RunEvent =
  | {
      type: "RUN_STARTED";
      taskId: string;
      orgId: string;
      userId: string;
      abortController: AbortController;
      runConfig?: Record<string, unknown>;
      podId?: string;
      /** The user message this turn executes — rides the in_progress thread-status event so the queue tray can flip exactly this item into the body at dispatch. */
      messageId?: string;
    }
  | {
      type: "RUN_RESUMED";
      taskId: string;
      orgId: string;
      userId: string;
      abortController: AbortController;
      podId: string;
    }
  | {
      type: "STEP_COMPLETED";
      taskId: string;
      orgId: string;
      stepCount: number;
    }
  /**
   * Terminal events carry orgId explicitly because the projector evicts the
   * RunState entry on these events (returns undefined), so the reactor cannot
   * look it up from post-projection state. This is a deliberate tradeoff:
   * the alternative would be to pass a (beforeState, afterState) pair to the
   * reactor, which is more ceremony for the same result.
   */
  | {
      type: "RUN_COMPLETED";
      taskId: string;
      orgId: string;
      stepCount: number;
    }
  | {
      type: "RUN_REQUIRES_ACTION";
      taskId: string;
      orgId: string;
      stepCount: number;
    }
  | {
      type: "RUN_FAILED";
      taskId: string;
      orgId: string;
      reason: RunFailedReason;
      /** Error text for `reason: "error"`, classified by the reactor into a
       *  `failure_kind` the board and a support query can group by. */
      errorText?: string | null;
      /**
       * Fence scope for a ghost force-fail (see the FORCE_FAIL command). Only
       * set on the ghost path; when present the reactor's `forceFailIfInProgress`
       * fails the thread ONLY if its current fence still matches — so a
       * follow-up turn already re-running under a new fence is left untouched.
       */
      expectedFenceToken?: string | null;
    }
  /**
   * Signals that a concurrent run was aborted to make room for a new one.
   * The AbortController is called in dispatch (before projection). The reactor
   * is intentionally a no-op for this event — the DB row is overwritten by
   * the subsequent RUN_STARTED event.
   */
  | { type: "PREVIOUS_RUN_ABORTED"; taskId: string; orgId: string };

/**
 * The result of applying a single event during dispatch: the event that was
 * emitted and the post-projection state (undefined when the run was evicted).
 */
export type RunTransition = { event: RunEvent; state: RunState | undefined };
