/**
 * Progress-based liveness. A run is "stuck" iff no progress has been recorded
 * within `idleTimeoutMs`. There is NO `startedAt` and no absolute-age cap, so:
 *   - legitimate hours-long runs never trip while progress keeps arriving (A1);
 *   - a resume cannot reset the clock to evade detection — only real progress
 *     advances `lastProgressAt` (A2).
 */
export function isRunStuck(input: {
  lastProgressAt: number; // epoch ms of the last progress signal
  now: number; // epoch ms
  idleTimeoutMs: number;
}): boolean {
  return input.now - input.lastProgressAt > input.idleTimeoutMs;
}
