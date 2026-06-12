import { logCpuProfilingStatus } from "./cpu";
import { startEventLoopMonitor } from "./event-loop";
import { startHeapWatch } from "./heap";
import { startStallWatchdog } from "./stall-stack";

/**
 * Single entry point for the profiling stack:
 * - CPU profiling status (Bun `--cpu-prof` launch flag — see cpu.ts)
 * - heap watch + on-demand snapshots (HEAP_WATCH — see heap.ts)
 * - event-loop delay monitor (EVENT_LOOP_MONITOR — see event-loop.ts)
 * - stall-stack watchdog (STALL_WATCHDOG — see stall-stack.ts)
 *
 * Returns a stop function that tears down every monitor it started.
 */
export function startProfiling(): () => void {
  logCpuProfilingStatus();
  const stops = [
    startHeapWatch(),
    startEventLoopMonitor(),
    startStallWatchdog(),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
