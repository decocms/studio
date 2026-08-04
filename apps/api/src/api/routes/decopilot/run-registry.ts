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
import { effectiveLastProgressAt, isRunStuck } from "./liveness";
import { meter } from "@/observability";

export type { RunReactorDeps };

const REAP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
/**
 * Idle timeout for the PROGRESS-based reaper. A run is reaped only after it has
 * gone `RUN_IDLE_TIMEOUT_MS` with no progress (no `last_progress_at` bump and,
 * as a fallback for runs that never bumped, no time since `startedAt`). This
 * replaces the old absolute 30-min age cap so legitimate hours-long runs that
 * keep streaming are never killed (A1), while a flapping run that resumes but
 * makes no real progress still trips (A2).
 *
 * Exported (unified-control-plane T4): also the ONE idle window the gate-side
 * consume path (`consume-run-projection.ts` → `natsChunkSource`) enforces on
 * the live subject tail. The reaper watches `last_progress_at` (DB-level,
 * cross-pod); the consume-side timer watches the subject directly
 * (in-process, per-attempt) — two different enforcement points, but they must
 * agree on the SAME window so neither fires meaningfully earlier/later than
 * the other for the same stall. See `livenessFailureReason` in
 * `projector-workflow.ts` for the consume-side terminal this produces.
 *
 * unified-control-plane T9: env-overridable so CI can prove the
 * liveness-terminal path (executor dies mid-run → thread reaches `failed`
 * with a "liveness" reason) without an e2e test waiting 10 real minutes.
 * Read ONCE at module load — this is a fixed, process-wide knob, never a
 * per-request parameter (same idiom as this directory's other module-level
 * `process.env` trace flags, e.g. `dispatch-run.ts`'s `FINISH_TRACE`). Unset
 * (every non-e2e environment, including production) keeps the 10-minute
 * default unchanged. `packages/e2e/playwright.config.ts` sets
 * `RUN_IDLE_TIMEOUT_MS` on the e2e webServer process only.
 */
const RUN_IDLE_TIMEOUT_MS_OVERRIDE = Number(process.env.RUN_IDLE_TIMEOUT_MS);
export const RUN_IDLE_TIMEOUT_MS =
  Number.isFinite(RUN_IDLE_TIMEOUT_MS_OVERRIDE) &&
  RUN_IDLE_TIMEOUT_MS_OVERRIDE > 0
    ? RUN_IDLE_TIMEOUT_MS_OVERRIDE
    : 10 * 60 * 1000; // 10 minutes

/** Events that mark a new inflight run. */
const INFLIGHT_START_EVENTS = new Set(["RUN_STARTED", "RUN_RESUMED"]);
/** Events that mark the end of an inflight run. */
const INFLIGHT_END_EVENTS = new Set([
  "RUN_COMPLETED",
  "RUN_FAILED",
  "RUN_REQUIRES_ACTION",
  "PREVIOUS_RUN_ABORTED",
]);

// `meter` is a NoopMeter until initObservability() runs at bootstrap
// (index.ts); this module is imported before that, so module-top instruments
// bind the noop and never export. Create lazily on first use (post-init).
const lazyInstrument = <T>(make: () => T): (() => T) => {
  let v: T | undefined;
  return () => (v ??= make());
};

const inflightRuns = lazyInstrument(() =>
  meter.createUpDownCounter("decopilot.stream.inflight", {
    description: "Number of in-flight decopilot stream requests",
    unit: "{requests}",
  }),
);

// I1: counter for reaper-forced run terminations — tagged by org.id and reason.
// Incremented in reapStaleRuns whenever a stuck run is force-failed.
const reapedRunsCounter = lazyInstrument(() =>
  meter.createCounter("decopilot.run.reaped", {
    description:
      "Number of decopilot runs force-failed by the progress-based reaper",
    unit: "{runs}",
  }),
);

export class RunRegistry {
  private readonly states = new Map<string, RunState>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: RunReactorDeps,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.reaperTimer = setInterval(() => {
      this.reapStaleRuns().catch((err) => {
        console.error("[RunRegistry] Reaper sweep failed", err);
      });
    }, REAP_INTERVAL_MS);
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
        inflightRuns().add(1, { "org.id": event.orgId });
      } else if (
        INFLIGHT_END_EVENTS.has(event.type) &&
        stateBeforeEvent?.status.tag === "running"
      ) {
        inflightRuns().add(-1, { "org.id": event.orgId });
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
   * Graceful shutdown: abort in-memory controllers (stops streamText loops and
   * cancels the daemon via the run's abort path) and clear state. Recovery of an
   * interrupted run is DBOS's job — the thread-gate workflow is durable and its
   * dispatch step is retriable, so DBOS re-runs it on another executor.
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

  /**
   * Progress-based reaper. For each running run, read the thread's
   * `last_progress_at` and force-fail only when `isRunStuck` — i.e. no progress
   * within `RUN_IDLE_TIMEOUT_MS`. When `last_progress_at` is null (a brand-new
   * run that hasn't streamed a chunk yet), the run's in-memory `startedAt` is
   * the baseline, so a just-started run is never instakilled. A DB read failure
   * is treated as "made progress" (skip) — the reaper must never kill a run on
   * a transient storage blip.
   *
   * Async (the previous version was sync) because it reads progress per run;
   * the timer fires it fire-and-forget.
   */
  private async reapStaleRuns(): Promise<void> {
    const now = this.clock().getTime();
    // Snapshot to avoid mutating the map while iterating across awaits.
    const running = [...this.states].filter(
      ([, state]) => state.status.tag === "running",
    );
    for (const [taskId, state] of running) {
      // Re-check liveness: the run may have finished during a prior await.
      const current = this.states.get(taskId);
      if (current?.status.tag !== "running") continue;

      let lastProgressAt: number;
      try {
        const progress = await this.deps.storage.getProgress(
          taskId,
          state.orgId,
        );
        // Baseline when the run hasn't recorded progress yet: its in-memory
        // start time. We use `state.status.startedAt` (this pod's clock, the
        // same one the reaper reads `now` from) rather than the DB
        // `run_started_at` (a wall-clock string written by whichever pod
        // claimed the run) so the idle window is measured consistently and a
        // brand-new run is never instakilled.
        lastProgressAt = effectiveLastProgressAt({
          persistedLastProgressAt: progress?.lastProgressAt ?? null,
          currentRunStartedAt: state.status.startedAt.getTime(),
        });
      } catch (err) {
        // Storage blip — assume progress, skip this sweep for this run.
        console.warn(
          `[RunRegistry] Reaper progress read failed for ${taskId}; skipping`,
          err,
        );
        continue;
      }

      if (
        !isRunStuck({ lastProgressAt, now, idleTimeoutMs: RUN_IDLE_TIMEOUT_MS })
      )
        continue;

      // The durable status is authoritative: a run may be completed or failed
      // by the projector out of band while its in-memory entry still says
      // "running". Such a run is finished, not stuck — evict the stale entry
      // without force-failing, so the reaper
      // never overwrites a `completed` run with `failed`. A DB read failure
      // falls through to the force-fail path (the reaper must still be able to
      // kill a genuinely stuck run when storage is momentarily unavailable).
      const durable = await this.deps.storage
        .get(taskId, state.orgId)
        .catch(() => null);
      if (durable && durable.status !== "in_progress") {
        const lingering = this.states.get(taskId);
        if (lingering?.status.tag === "running") {
          lingering.status.abortController.abort();
        }
        this.states.delete(taskId);
        continue;
      }

      console.warn(
        `[RunRegistry] Reaping stuck run for thread ${taskId} (idle > ${
          RUN_IDLE_TIMEOUT_MS / 60_000
        }m) ...`,
      );
      // I1: emit metric before force-fail so it's visible even if execute() throws.
      reapedRunsCounter().add(1, {
        "org.id": state.orgId,
        reason: "idle_timeout",
      });
      await this.execute({
        type: "FORCE_FAIL",
        taskId,
        reason: "reaped",
      }).catch((err) => {
        console.error("[RunRegistry] Reaper execute failed", err);
      });
    }
  }
}
