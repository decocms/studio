/**
 * Process-wide gate on concurrent subagent streams.
 *
 * The `subtask` tool is documented to fan out ("launch multiple subtask calls
 * in the same message"), and each call spawns a full nested agent stream
 * (`runAgentLoop` + stream drain). With no bound, one busy session can start
 * dozens of concurrent streams on a single pod; since the event loop is
 * single-threaded, that pegs CPU and floods the microtask queue, starving
 * everything else (pg pool acquires, even signal handlers). This caps how many
 * run at once per process — excess calls queue and start as slots free.
 *
 * The limit comes from `Settings.decopilotMaxConcurrentSubagents`
 * (DECOPILOT_MAX_CONCURRENT_SUBAGENTS), validated at startup — a malformed
 * value fails boot instead of silently coercing here. Consider a per-run (not
 * per-process) gate if cross-session head-of-line blocking becomes a concern.
 */

import { getSettings } from "@/settings";

export interface ConcurrencyGate {
  /**
   * Acquire a slot, waiting if at capacity. Returns a release function; call it
   * exactly once (idempotent) when the work is done, including on error/abort.
   *
   * `priority` orders the WAITERS only (lower goes first, ties keep arrival
   * order) — it never preempts a slot already held, so a low-priority run that
   * started is never killed to make room. Omit for FIFO, which is what every
   * caller that doesn't care gets.
   */
  acquire(priority?: number): Promise<() => void>;
  /** Slots currently held (testing/observability). */
  readonly active: number;
  /** Callers waiting for a slot (testing/observability). */
  readonly pending: number;
}

export function createConcurrencyGate(max: number): ConcurrencyGate {
  // A NaN/Infinity `max` (e.g. from an unguarded env parse) must not reach
  // `Math.max` here: Math.max(1, NaN) is NaN, and `active < NaN` is always
  // false, so every acquire() would park forever — a total deadlock instead
  // of the intended cap.
  const limit = Number.isFinite(max) ? Math.max(1, max) : 1;
  let active = 0;
  // Sorted by (priority, arrival). A plain array + insertion scan, not a heap:
  // the queue is bounded by how many runs one pod can have in flight (tens), so
  // an O(n) insert is free and a heap would be code to maintain for nothing.
  let arrivals = 0;
  const waiters: Array<{ priority: number; seq: number; wake: () => void }> =
    [];

  return {
    async acquire(priority = 0) {
      if (active < limit) {
        active++;
      } else {
        // Parked: the eventual release() hands this slot off directly
        // (active is never decremented for it), so no increment here either.
        await new Promise<void>((wake) => {
          const entry = { priority, seq: arrivals++, wake };
          // Last index whose priority is <= ours — insert after it, so equal
          // priorities stay FIFO.
          let i = waiters.length;
          while (i > 0 && waiters[i - 1]!.priority > priority) i--;
          waiters.splice(i, 0, entry);
        });
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = waiters.shift();
        if (next) {
          next.wake();
        } else {
          active--;
        }
      };
    },
    get active() {
      return active;
    },
    get pending() {
      return waiters.length;
    },
  };
}

const gate = createConcurrencyGate(
  getSettings().decopilotMaxConcurrentSubagents,
);

export const acquireSubagentSlot = (): Promise<() => void> => gate.acquire();
