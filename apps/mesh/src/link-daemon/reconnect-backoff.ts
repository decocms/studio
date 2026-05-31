/**
 * Reconnect policy for the daemon's WebSocket to mesh. Standard exponential
 * backoff with jitter, capped at 30s. WS close code 4001 means the cluster
 * accepted a newer connection for the same user (last-link-wins) — reconnecting
 * would just oscillate, so we don't.
 */

import { exponentialBackoffWithJitter } from "@/shared/async/backoff";

export const WS_CLOSE_SUPERSEDED = 4001;
const BASE_MS = 500;
const CAP_MS = 30_000;

export function computeBackoffMs(attempt: number): number {
  if (attempt < 1) throw new Error("attempt must be >= 1");
  return exponentialBackoffWithJitter(CAP_MS, BASE_MS, attempt - 1, 2, 0.5);
}

export function shouldReconnectOnClose(code: number): boolean {
  return code !== WS_CLOSE_SUPERSEDED;
}
