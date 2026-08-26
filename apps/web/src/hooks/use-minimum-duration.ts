import { useEffect, useRef, useState } from "react";

/** Milliseconds still owed before a run that began at `startedAt` may end. */
export function remainingHoldMs(
  startedAt: number | null,
  now: number,
  minMs: number,
): number {
  if (startedAt === null) return 0;
  // A backwards clock (NTP) must not owe MORE than the window.
  return Math.max(0, minMs - Math.max(0, now - startedAt));
}

/** `active`, but never true for less than `minMs` — a faster flip reads as a flicker. */
export function useMinimumDuration(active: boolean, minMs: number): boolean {
  const [held, setHeld] = useState(active);
  /** Start of the current run; null while released, so re-activating extends it. */
  const startedAtRef = useRef<number | null>(active ? Date.now() : null);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- timer-based release has no render-time expression
  useEffect(() => {
    if (active) {
      startedAtRef.current ??= Date.now();
      setHeld(true);
      return;
    }
    if (!held) return;
    const release = () => {
      startedAtRef.current = null;
      setHeld(false);
    };
    const remaining = remainingHoldMs(startedAtRef.current, Date.now(), minMs);
    if (remaining === 0) {
      release();
      return;
    }
    const id = setTimeout(release, remaining);
    return () => clearTimeout(id);
  }, [active, held, minMs]);

  return held;
}
