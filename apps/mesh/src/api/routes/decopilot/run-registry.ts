/**
 * RunRegistry — stateful dispatcher for decopilot run lifecycle
 *
 * Wraps the pure decide + project functions into a stateful registry. Tracks
 * all in-flight runs by taskId. A reaper timer evicts runs that have been
 * in the "running" state for longer than MAX_RUN_AGE_MS.
 *
 * Entry points:
 *   execute(command)           — dispatch + react in one call (common case)
 *   dispatch(command)          — sync only; use when you need to inspect the
 *                                resulting transitions before reacting
 *   react(transitions)         — apply the reactor to already-dispatched
 *                                transitions; pair with dispatch() above
 */

import type { RunCommand, RunTransition, RunState } from "./run-state";
import { decide } from "./run-decider";
import { project } from "./run-projector";
import type { RunReactorDeps } from "./run-reactor";
import { reactAll } from "./run-reactor";
import { meter } from "@/observability";

export type { RunReactorDeps };

const REAP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RUN_AGE_MS = 30 * 60 * 1000; // 30 minutes

/** Events that mark a new inflight run. */
const INFLIGHT_START_EVENTS = new Set(["RUN_STARTED", "RUN_RESUMED"]);
/** Events that mark the end of an inflight run. */
const INFLIGHT_END_EVENTS = new Set([
  "RUN_COMPLETED",
  "RUN_FAILED",
  "RUN_REQUIRES_ACTION",
  "PREVIOUS_RUN_ABORTED",
]);

const inflightRuns = meter.createUpDownCounter("decopilot.stream.inflight", {
  description: "Number of in-flight decopilot stream requests",
  unit: "{requests}",
});

export class RunRegistry {
  private readonly states = new Map<string, RunState>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: RunReactorDeps,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.reaperTimer = setInterval(
      () => this.reapStaleRuns(),
      REAP_INTERVAL_MS,
    );
  }

  /**
   * Convenience wrapper: dispatch the command, then run the reactor against
   * all resulting transitions. Returns the transitions for callers that need
   * to inspect which events were produced.
   */
  async execute(command: RunCommand): Promise<RunTransition[]> {
    const transitions = this.dispatch(command);
    await this.react(transitions);
    return transitions;
  }

  /**
   * Sync half of the pipeline: run the command through the decider, fold each
   * resulting event through the projector, and return the transitions produced.
   * Call react() afterwards to trigger DB/SSE side effects, or use execute()
   * to do both in one step.
   */
  dispatch(command: RunCommand): RunTransition[] {
    const current = this.states.get(command.taskId);
    const events = decide(command, current);
    const transitions: RunTransition[] = [];

    for (const event of events) {
      const stateBeforeEvent = this.states.get(event.taskId);

      // Abort the running controller before projecting it away
      if (
        event.type === "PREVIOUS_RUN_ABORTED" ||
        event.type === "RUN_FAILED"
      ) {
        if (stateBeforeEvent?.status.tag === "running") {
          stateBeforeEvent.status.abortController.abort();
        }
      }

      const newState = project(stateBeforeEvent, event, this.clock());

      if (newState === undefined) {
        this.states.delete(event.taskId);
      } else {
        this.states.set(event.taskId, newState);
      }

      transitions.push({ event, state: newState });

      // Update inflight metric — only decrement when this registry had a
      // running state; ghost FORCE_FAIL events have no prior increment.
      if (INFLIGHT_START_EVENTS.has(event.type)) {
        inflightRuns.add(1, { "org.id": event.orgId });
      } else if (
        INFLIGHT_END_EVENTS.has(event.type) &&
        stateBeforeEvent?.status.tag === "running"
      ) {
        inflightRuns.add(-1, { "org.id": event.orgId });
      }
    }

    return transitions;
  }

  /**
   * Async half of the pipeline: run the reactor against transitions returned
   * by a prior dispatch() call. Use this when you need to inspect transitions
   * synchronously before triggering side effects (e.g. onStepFinish).
   */
  react(transitions: RunTransition[]): Promise<void> {
    return reactAll(transitions, this.deps);
  }

  /** Returns the AbortSignal for the running thread, or null if not running. */
  getAbortSignal(taskId: string): AbortSignal | null {
    const state = this.states.get(taskId);
    if (state?.status.tag === "running") {
      return state.status.abortController.signal;
    }
    return null;
  }

  /** Returns true when the thread currently has an active run in progress. */
  isRunning(taskId: string): boolean {
    return this.states.get(taskId)?.status.tag === "running";
  }

  /**
   * Graceful shutdown: abort in-memory controllers and clear state.
   * Recovery of the aborted runs is handled by DBOS — the workflow
   * row stays PENDING in `dbos.workflow_status`, and when this pod
   * (same executor_id = POD_NAME) relaunches, DBOS re-runs the
   * dispatch step from scratch.
   */
  async stopAll(): Promise<void> {
    for (const [, state] of this.states) {
      if (state.status.tag === "running") {
        state.status.abortController.abort();
      }
    }
    this.states.clear();
  }

  /** Stop the reaper timer. Call once during server shutdown. */
  dispose(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  private reapStaleRuns(): void {
    const now = this.clock().getTime();
    for (const [taskId, state] of this.states) {
      if (
        state.status.tag === "running" &&
        now - state.status.startedAt.getTime() > MAX_RUN_AGE_MS
      ) {
        console.warn(
          `[RunRegistry] Reaping stale run for thread ${taskId} ...`,
        );
        this.execute({
          type: "FORCE_FAIL",
          taskId,
          reason: "reaped",
        }).catch((err) => {
          console.error("[RunRegistry] Reaper execute failed", err);
        });
      }
    }
  }
}
