import { meter } from "./index";

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
const delayHistogram = meter.createHistogram("eventloop.delay", {
  description: "Event-loop lag measured as timer scheduling drift",
  unit: "ms",
});

let timer: ReturnType<typeof setInterval> | undefined;

export function startEventLoopMonitor(): () => void {
  if (process.env.EVENT_LOOP_MONITOR !== "1") return () => {};
  const intervalMs = Number(process.env.EVENT_LOOP_INTERVAL_MS ?? 250);
  const spikeMs = Number(process.env.EVENT_LOOP_SPIKE_MS ?? 100);

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
