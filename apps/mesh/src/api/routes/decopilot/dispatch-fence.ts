/**
 * Per-turn fence-token minting for `prepareRun`.
 *
 * A run's id is its thread id, which is STABLE across the multiple turns a
 * thread sees. The fence token, by contrast, MUST be fresh per turn: it scopes
 * the JetStream dedup key (`Nats-Msg-Id = ${runId}:${fenceToken}:${seq}`) and
 * the projector's per-(runId, fenceToken) accumulator. A reused token would let
 * a later turn's seq-1 chunk dedup against the prior turn's, and would merge two
 * turns into one projector accumulator. Minting a fresh UUID every call keeps
 * each turn (and each DBOS-replay epoch) isolated.
 *
 * Kept as a tiny pure unit so the "fresh per turn" invariant is unit-testable
 * without standing up `prepareRun`'s full StudioContext/registry/DB wiring.
 */
export function mintRunFenceToken(): string {
  return crypto.randomUUID();
}
