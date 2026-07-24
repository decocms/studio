/**
 * Deterministic id scheme for synthesized error messages.
 *
 * Error message ids are namespaced by `(runId, fenceToken)`. The fence token is
 * minted fresh per TURN, while `runId === threadId` is STABLE across every turn
 * of a thread. Including the fence keeps DISTINCT turns of the same thread
 * disjoint: the live and projector paths dedupe the SAME error within a turn
 * while distinct turns never collide.
 */

/**
 * Deterministic id for the error part the kernel synthesizes when a run's chunk
 * source throws. Namespaced per turn so the live and projector paths dedupe the
 * SAME error within a turn while distinct turns never collide.
 */
export function synthesizedErrorMessageId(
  runId: string,
  fenceToken: string,
): string {
  return `error-${runId}:${fenceToken}`;
}
