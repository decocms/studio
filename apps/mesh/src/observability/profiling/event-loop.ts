import { meter } from "../index";

/**
 * Event-loop delay monitor (timer-drift technique).
 *
 * node:perf_hooks `monitorEventLoopDelay` is a non-functional stub under Bun
 * (reports ~0 regardless of real blocking), so lag is measured as the drift
 * between a timer's expected and actual fire time — the wall-clock a blocked
 * main thread couldn't run the timer.
 *
 * Exists to explain "Slow pool acquire" warnings that fire with idle
 * connections and an empty wait queue: pg defers idle-client handoff through
 * process.nextTick, so a blocked loop inflates measured acquire time. Spikes
 * are logged with memory stats to correlate with GC pauses.
 */
let timer: ReturnType<typeof setInterval> | undefined;

// Always-on, ultra-cheap lag sampler (independent of EVENT_LOOP_MONITOR) so
// other subsystems can tell event-loop stalls apart from genuinely slow work.
// The slow-query log uses it to avoid blaming Postgres for time the query
// callback actually spent queued behind a blocked main thread.
let lagSampler: ReturnType<typeof setInterval> | undefined;
let lastLagMs = 0;
const LAG_SAMPLE_INTERVAL_MS = 500;

function startLagSampler(): void {
  if (lagSampler) return;
  let expected = performance.now() + LAG_SAMPLE_INTERVAL_MS;
  lagSampler = setInterval(() => {
    const now = performance.now();
    lastLagMs = Math.max(0, now - expected);
    expected = now + LAG_SAMPLE_INTERVAL_MS;
  }, LAG_SAMPLE_INTERVAL_MS);
  lagSampler.unref?.();
}

/**
 * Most recent event-loop lag sample in ms (timer scheduling drift). Lazily
 * starts the sampler on first read, so callers don't need init wiring.
 */
export function getEventLoopLagMs(): number {
  startLagSampler();
  return lastLagMs;
}

export function startEventLoopMonitor(): () => void {
  // Start the lightweight sampler eagerly at boot so the first slow query
  // already has lag data to classify against.
  startLagSampler();

  if (process.env.EVENT_LOOP_MONITOR !== "1") return () => {};
  const intervalMs = Number(process.env.EVENT_LOOP_INTERVAL_MS ?? 250);
  const spikeMs = Number(process.env.EVENT_LOOP_SPIKE_MS ?? 100);

  // Create the instrument here, not at module top: `meter` is a no-op until
  // initObservability() reassigns it, and module-top capture binds the dead
  // pre-init meter (instruments never export). This runs post-init.
  const delayHistogram = meter.createHistogram("eventloop.delay", {
    description: "Event-loop lag measured as timer scheduling drift",
    unit: "ms",
  });

  let expected = performance.now() + intervalMs;
  timer = setInterval(() => {
    const now = performance.now();
    const drift = Math.max(0, now - expected);
    expected = now + intervalMs;

    delayHistogram.record(drift);

    if (drift > spikeMs) {
      const m = process.memoryUsage();
      console.warn(
        JSON.stringify({
          msg: "event-loop-stall",
          ts: new Date().toISOString(),
          lagMs: Math.round(drift),
          rss: m.rss,
          heapUsed: m.heapUsed,
          heapTotal: m.heapTotal,
          external: m.external,
        }),
      );
    }
  }, intervalMs);
  timer.unref?.();

  return () => {
    if (timer) clearInterval(timer);
  };
}
