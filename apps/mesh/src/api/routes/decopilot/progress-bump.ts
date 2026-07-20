/**
 * Progress-bump throttle (Task 9, A1/A2).
 *
 * The run's UI stream is the liveness signal: every chunk that flows out is
 * "progress". But writing `last_progress_at = now()` per chunk would hammer the
 * DB (hundreds of writes per second per run). This throttle collapses that into
 * at most one write per `intervalMs` (~3s) per run.
 *
 * It deliberately does NOT write a part row or carry any payload — it's a pure
 * heartbeat. The reaper reads `last_progress_at` to decide whether a run is
 * stuck (`isRunStuck`); a brand-new run that hasn't bumped yet falls back to
 * its in-memory `startedAt`, so a missed first bump never instakills it.
 */

const DEFAULT_INTERVAL_MS = 3_000;

/**
 * Per-process throttle keyed by taskId. `shouldBump(taskId, now)` returns true
 * at most once per `intervalMs` per task and records the time it returned true.
 * Call the DB write only when it returns true.
 */
export class ProgressBumpThrottle {
  private readonly lastBumpMs = new Map<string, number>();

  constructor(private readonly intervalMs: number = DEFAULT_INTERVAL_MS) {}

  /**
   * @param taskId - run/thread id.
   * @param now    - epoch-ms (injectable for tests; defaults to Date.now()).
   * @returns true when the caller should perform the bump (and the throttle
   *          has recorded `now` as the last bump time).
   */
  shouldBump(taskId: string, now: number = Date.now()): boolean {
    const last = this.lastBumpMs.get(taskId);
    if (last !== undefined && now - last < this.intervalMs) return false;
    this.lastBumpMs.set(taskId, now);
    return true;
  }

  /** Forget a task's throttle state once its run ends (avoid unbounded growth). */
  clear(taskId: string): void {
    this.lastBumpMs.delete(taskId);
  }
}

/**
 * Tap a chunk stream so each chunk drives a THROTTLED `onBump()` call. Pure
 * pass-through: every chunk is forwarded unchanged; `onBump` is a
 * fire-and-forget side effect that must never block or fail the stream —
 * callers should swallow their own errors (see projector-workflow.ts, which
 * drives this for the `ReadableStream`-shaped `chunkStream` used by
 * project-chunks.ts).
 *
 * This is the run's liveness heartbeat for BOTH topologies: desktop chunks
 * go daemon → NATS directly, so the projector's live chunk consumption is
 * the only studio component that ever sees them; hosted runs are also
 * live-tailed by the projector post-unification, so this one tap covers
 * both — see the reaper's `RUN_IDLE_TIMEOUT_MS` in run-registry.ts.
 */
export function tapProgressStream<T>(
  stream: ReadableStream<T>,
  taskId: string,
  throttle: ProgressBumpThrottle,
  onBump: () => void,
): ReadableStream<T> {
  return stream.pipeThrough(
    new TransformStream<T, T>({
      transform(chunk, controller) {
        if (throttle.shouldBump(taskId)) onBump();
        controller.enqueue(chunk);
      },
      flush() {
        // Stream ended — drop this task's throttle state so the map can't
        // grow unbounded across many short-lived runs.
        throttle.clear(taskId);
      },
    }),
  );
}
