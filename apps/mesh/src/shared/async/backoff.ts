// Ported from Deno std @std/async (_util.ts). MIT license, Copyright the Deno
// authors. https://github.com/denoland/std/blob/main/async/_util.ts
//
// The canonical exponential-backoff-with-jitter calculator for this repo. Use
// this (and `retry()` in ./retry) for ALL retry/backoff timing — do NOT
// hand-roll another `Math.min(base * 2 ** attempt, cap)` + jitter formula. This
// was consolidated from ~9 ad-hoc copies.

/**
 * Exponential backoff delay with optional jitter.
 *
 * Base delay grows as `base * multiplier ** attempt` (attempt is 0-based),
 * capped at `cap`. Jitter then scales the result down by a random factor:
 *   - `jitter = 0`  → no jitter, the full capped backoff.
 *   - `jitter = 1`  → "full jitter", uniformly random in `[0, exp]`.
 *   - `jitter = 0.5`→ "equal jitter", uniformly random in `[exp/2, exp]`.
 *
 * @param cap maximum delay in ms (the backoff is capped here before jitter).
 * @param base initial/minimum delay in ms (the delay at attempt 0).
 * @param attempt 0-based attempt index.
 * @param multiplier growth factor per attempt (commonly 2).
 * @param jitter randomization amount in `[0, 1]`.
 * @returns the delay in milliseconds to wait before the next attempt.
 */
export function exponentialBackoffWithJitter(
  cap: number,
  base: number,
  attempt: number,
  multiplier: number,
  jitter: number,
): number {
  const exp = Math.min(cap, base * multiplier ** attempt);
  return (1 - jitter * Math.random()) * exp;
}
