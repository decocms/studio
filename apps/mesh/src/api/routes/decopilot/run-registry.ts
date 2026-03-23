/**
 * RunRegistry — stateful dispatcher for decopilot run lifecycle
 *
 * Wraps the pure decide + project functions into a stateful registry. Tracks
 * all in-flight runs by threadId. A reaper timer evicts runs that have been
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
import type { Thread } from "@/storage/types";

export type { RunReactorDeps };

const REAP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RUN_AGE_MS = 30 * 60 * 1000; // 30 minutes

export class RunRegistry {
  private readonly states = new Map<string, RunState>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: RunReactorDeps,
    private readonly podId: string,
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
    const current = this.states.get(command.threadId);
    const events = decide(command, current);
    const transitions: RunTransition[] = [];

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

      transitions.push({ event, state: newState });
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
   * Graceful shutdown: orphan all runs in the DB first (so they are resumable
   * if the process dies), then abort in-memory controllers and clear state.
   * The DB write MUST happen before states.clear() — if the process dies
   * between clear() and the DB write, threads would be permanently stuck.
   */
  async stopAll(): Promise<void> {
    // 1. DB: orphan all runs owned by this pod FIRST
    //    (if process dies after this, runs are resumable)
    try {
      await this.deps.storage.orphanRunsByPod(this.podId);
    } catch (err) {
      console.error("[RunRegistry] Failed to orphan runs in DB:", err);
    }
    // 2. In-memory: abort all controllers (stops streamText loops)
    for (const [, state] of this.states) {
      if (state.status.tag === "running") {
        state.status.abortController.abort();
      }
    }
    // 3. In-memory: clear map
    this.states.clear();
  }

  /**
   * Recover all orphaned runs on startup. Server crashes shouldn't
   * punish users — every in-progress run gets resumed automatically.
   * Concurrency is capped at 5 concurrent resumes.
   */
  async recoverOrphanedRuns(
    resumeFn: (thread: Thread) => Promise<void>,
  ): Promise<void> {
    const orphans = await this.deps.storage.listOrphanedRuns(this.podId);
    if (orphans.length === 0) return;

    // Concurrency cap: max 5 concurrent resumes
    const CONCURRENCY = 5;
    for (let i = 0; i < orphans.length; i += CONCURRENCY) {
      const batch = orphans.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (thread) => {
          const claimed = await this.deps.storage.claimOrphanedRun(
            thread.id,
            thread.organization_id,
            this.podId,
          );
          if (!claimed) return; // Another pod got it

          try {
            await resumeFn(thread);
          } catch (err) {
            console.error(`[RunRegistry] Failed to resume ${thread.id}:`, err);
            await this.deps.storage
              .forceFailIfInProgress(thread.id, thread.organization_id)
              .catch(() => {});
          }
        }),
      );
    }
  }

  /**
   * Handle a dead pod notification from the heartbeat watcher. Finds all
   * in-progress threads owned by the dead pod, broadcasts cancel (in case
   * it's partitioned, not dead), then CAS-claims and resumes each orphan.
   */
  async handlePodDeath(
    deadPodId: string,
    resumeFn: (thread: Thread) => Promise<void>,
    cancelBroadcast?: { broadcast(threadId: string): void },
  ): Promise<void> {
    const orphans = await this.deps.storage.listOrphanedRunsByPod(deadPodId);
    if (orphans.length === 0) return;

    // Cancel running threads on the dead pod (in case it's alive but partitioned)
    for (const thread of orphans) {
      cancelBroadcast?.broadcast(thread.id);
    }

    const CONCURRENCY = 5;
    for (let i = 0; i < orphans.length; i += CONCURRENCY) {
      const batch = orphans.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (thread) => {
          if (this.isRunning(thread.id)) return;
          const claimed = await this.deps.storage.claimOrphanedRun(
            thread.id,
            thread.organization_id,
            this.podId,
          );
          if (!claimed) return;

          try {
            await resumeFn(thread);
          } catch (err) {
            console.error(`[RunRegistry] Failed to resume ${thread.id}:`, err);
            await this.deps.storage
              .forceFailIfInProgress(thread.id, thread.organization_id)
              .catch(() => {});
          }
        }),
      );
    }
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
        this.execute({
          type: "FORCE_FAIL",
          threadId,
          reason: "reaped",
        }).catch((err) => {
          console.error("[RunRegistry] Reaper execute failed", err);
        });
      }
    }
  }
}
