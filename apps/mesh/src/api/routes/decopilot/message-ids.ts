/**
 * Deterministic id scheme for projected assistant messages and synthesized
 * error messages.
 *
 * Ids are namespaced by `(runId, fenceToken)`. The fence token is minted fresh
 * per TURN (run attempt), while `runId === threadId` is STABLE across every
 * turn of a thread. Including the fence makes each turn its own id namespace:
 *
 *   - The SAME turn re-folded — terminal projection, checkpoint passes, and the
 *     live + projector double-write — reassembles IDENTICAL ids, so the part
 *     row ids (`${runId}:${messageId}:${seq}`) collide on `ON CONFLICT (id) DO
 *     NOTHING` and dedupe (the invariant introduced by #4044).
 *
 *   - DISTINCT turns of the same thread can NEVER collide. Before this, the id
 *     was `${runId}:msg:${n}` with the counter reset to 0 each fold, so turn 2's
 *     assistant message was `${runId}:msg:0` — byte-identical to turn 1's — and
 *     its part rows were silently discarded by `ON CONFLICT DO NOTHING`. When
 *     turn 2 folded to ≤ turn 1's part count it was erased entirely and the UI
 *     rendered "No response was generated" even though the harness produced (and
 *     relayed) a full response.
 *
 * Both the durable projector (`project-run.ts`) and the live ingest path
 * (`ingest-run.ts`, `dispatch-run.ts`) MUST use these helpers so their ids match
 * within a turn and differ across turns.
 */

/**
 * Build a deterministic, fold-ordered assistant-message-id generator for one
 * run attempt. Successive calls yield `${runId}:${fenceToken}:msg:0`,
 * `:msg:1`, … in fold order.
 */
export function assistantMessageIdGenerator(
  runId: string,
  fenceToken: string,
): () => string {
  let index = 0;
  return () => `${runId}:${fenceToken}:msg:${index++}`;
}

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
