import { logCpuProfilingStatus } from "./cpu";
import { startEventLoopMonitor } from "./event-loop";
import { startHeapWatch } from "./heap";

/**
 * Single entry point for the profiling stack:
 * - CPU profiling status (Bun `--cpu-prof` launch flag — see cpu.ts)
 * - heap watch + on-demand snapshots (HEAP_WATCH — see heap.ts)
 * - event-loop delay monitor (EVENT_LOOP_MONITOR — see event-loop.ts)
 *
 * Returns a stop function that tears down every monitor it started.
 */
export function startProfiling(): () => void {
  logCpuProfilingStatus();
  const stops = [startHeapWatch(), startEventLoopMonitor()];
  return () => {
    for (const stop of stops) stop();
  };
}
