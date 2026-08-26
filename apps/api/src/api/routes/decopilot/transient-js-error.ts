/**
 * A JetStream round-trip that failed transiently (server briefly slow /
 * mid-election / no responders yet) rather than because the request is
 * semantically wrong. Only these are worth retrying — a bad stream config
 * would fail identically every attempt.
 *
 * Two messages read like permanent config errors but are not: "not enabled" is
 * what a leaderless cluster reports, and "is offline" is what a stream or
 * consumer whose RAFT group has no leader reports.
 *
 * Shared by every JetStream caller on the run path: the stream buffer's init
 * and publish retries (`nats-stream-buffer.ts`) and the projector's consumer
 * open (`projector-chunk-stream.ts`). One predicate so a transient class
 * recognized on the producer side is not treated as permanent on the consumer
 * side — which is exactly how "stream is offline" killed runs on 2026-08-26
 * while the publish path was already retrying it.
 */
export function isTransientJsApiError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError") return true;
  return /timeout|no responders|503|not enabled|is offline/i.test(err.message);
}
