/**
 * Throttle gate for the durable `run_acked_seq` high-water writes.
 *
 * Writing the contiguous ack floor to the DB on every published chunk would
 * hammer the database (potentially hundreds of writes per second per run).
 * This throttle collapses those into at most one write per `intervalMs` (~3s),
 * mirroring the `ProgressBumpThrottle` intent for `last_progress_at`.
 *
 * Pure: the current time is injected via `nowMs` so tests can control it
 * without any async primitives.
 */

const DEFAULT_INTERVAL_MS = 3_000;

export interface AckedSeqThrottle {
  /**
   * Returns true when the caller should persist the current seq floor:
   * - always on the first call (no prior write recorded)
   * - when at least `intervalMs` has elapsed since the last time it returned true
   */
  shouldWrite(seq: number): boolean;
}

/**
 * Create a per-run acked-seq write throttle.
 *
 * Note: the terminal (final) flush is the CALLER's responsibility — the caller
 * must unconditionally call `bumpAckedSeq` after the run completes so the
 * durable floor reflects the last published seq. This throttle only rate-limits
 * intermediate writes; it does not guarantee a write on the last chunk.
 *
 * @param nowMs      - injectable clock (epoch-ms); defaults to `Date.now`.
 * @param intervalMs - minimum ms between successive writes; defaults to 3000.
 */
export function makeAckedSeqThrottle(
  nowMs: () => number = Date.now,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): AckedSeqThrottle {
  let lastWriteMs: number | undefined;

  return {
    shouldWrite(_seq: number): boolean {
      const now = nowMs();
      if (lastWriteMs === undefined || now - lastWriteMs >= intervalMs) {
        lastWriteMs = now;
        return true;
      }
      return false;
    },
  };
}
