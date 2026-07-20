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
 * DRAFT: limit is read from the environment with a conservative default. If we
 * keep this, move it into Settings (resolve-config.ts) so it's tunable per
 * deployment without an env redeploy, and consider a per-run (not per-process)
 * gate if cross-session head-of-line blocking becomes a concern.
 */

export interface ConcurrencyGate {
  /**
   * Acquire a slot, waiting if at capacity. Returns a release function; call it
   * exactly once (idempotent) when the work is done, including on error/abort.
   */
  acquire(): Promise<() => void>;
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
  const waiters: Array<() => void> = [];

  return {
    async acquire() {
      if (active < limit) {
        active++;
      } else {
        // Parked: the eventual release() hands this slot off directly
        // (active is never decremented for it), so no increment here either.
        await new Promise<void>((resolve) => waiters.push(resolve));
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = waiters.shift();
        if (next) {
          next();
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
  Number(process.env.DECOPILOT_MAX_CONCURRENT_SUBAGENTS ?? 4),
);

export const acquireSubagentSlot = (): Promise<() => void> => gate.acquire();
