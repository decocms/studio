/**
 * RunRegistry — in-memory event-sourced dispatcher for Decopilot run state
 *
 * Wraps the pure decider + projector into a stateful registry. Tracks all
 * in-flight and recently-finished runs by threadId. A reaper timer evicts
 * runs that have been in the "running" state for longer than MAX_RUN_AGE_MS.
 */

import type { RunCommand, RunEventPair, RunState } from "./run-state";
import { decide } from "./run-decider";
import { project } from "./run-projector";
import type { RunReactorDeps } from "./run-reactor";
import { reactAll } from "./run-reactor";

export type { RunReactorDeps };

const REAP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RUN_AGE_MS = 30 * 60 * 1000; // 30 minutes

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
   * Apply a command: run it through the decider, fold each resulting event
   * through the projector, and return the (event, state) pairs produced.
   */
  dispatch(command: RunCommand): RunEventPair[] {
    const current = this.states.get(command.threadId);
    const events = decide(command, current);
    const pairs: RunEventPair[] = [];

    for (const event of events) {
      const stateBeforeEvent = this.states.get(event.threadId);

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
        this.states.delete(event.threadId);
      } else {
        this.states.set(event.threadId, newState);
      }

      pairs.push({ event, state: newState });
    }

    return pairs;
  }

  /** Returns the AbortSignal for the running thread, or null if not running. */
  getAbortSignal(threadId: string): AbortSignal | null {
    const state = this.states.get(threadId);
    if (state?.status.tag === "running") {
      return state.status.abortController.signal;
    }
    return null;
  }

  /** Returns true when the thread currently has an active run in progress. */
  isRunning(threadId: string): boolean {
    return this.states.get(threadId)?.status.tag === "running";
  }

  /**
   * Abort every running entry, persist failure status, and clear the map.
   * Called during graceful shutdown.
   */
  stopAll(): void {
    for (const [threadId, state] of this.states) {
      if (state.status.tag === "running") {
        state.status.abortController.abort();
        this.deps.storage
          .update(threadId, { status: "failed" })
          .catch(() => {});
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
    for (const [threadId, state] of this.states) {
      if (
        state.status.tag === "running" &&
        now - state.status.startedAt.getTime() > MAX_RUN_AGE_MS
      ) {
        console.warn(
          `[RunRegistry] Reaping stale run for thread ${threadId} ...`,
        );
        const pairs = this.dispatch({
          type: "FORCE_FAIL",
          threadId,
          reason: "reaped",
        });
        reactAll(pairs, this.deps).catch((err) => {
          console.error("[RunRegistry] Reaper reactAll failed", err);
        });
      }
    }
  }
}
