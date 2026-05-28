/**
 * Reconnect policy for the daemon's WebSocket to mesh. Standard exponential
 * backoff with jitter, capped at 30s. WS close code 4001 means the cluster
 * accepted a newer connection for the same user (last-link-wins) — reconnecting
 * would just oscillate, so we don't.
 */

export const WS_CLOSE_SUPERSEDED = 4001;
const BASE_MS = 500;
const CAP_MS = 30_000;

export function computeBackoffMs(attempt: number): number {
  if (attempt < 1) throw new Error("attempt must be >= 1");
  const exp = Math.min(BASE_MS * 2 ** (attempt - 1), CAP_MS);
  // Full jitter: [exp/2, exp]
  return exp / 2 + Math.random() * (exp / 2);
}

export function shouldReconnectOnClose(code: number): boolean {
  return code !== WS_CLOSE_SUPERSEDED;
}
