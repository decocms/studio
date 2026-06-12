/**
 * Token refresh timer for the WS uplink sender (spec §5.2 S2, the "Expected 101"
 * fix). The daemon must reconnect with a FRESH bearer before its current one
 * expires — never pin the startup token. This is the pure, clock-injected
 * decision; the sender arms a timer at `refreshAtMs` and reconnects via
 * getAccessToken() at that point.
 */
export interface TokenRefreshSchedule {
  /** Absolute ms when a fresh bearer is needed; reconnect at/after this time. */
  refreshAtMs: number;
  /** True if `expiresAt` is already in the past. */
  isExpired: boolean;
  /** Remaining ms until refresh (clamped at 0). */
  remainingMs: number;
}

/** Reconnect this long before expiry so a token is never pinned past its TTL. */
export const DEFAULT_TOKEN_SKEW_MS = 5 * 60 * 1000;

export function scheduleTokenRefresh(
  expiresAt: number,
  { nowMs, skewMs = DEFAULT_TOKEN_SKEW_MS }: { nowMs: number; skewMs?: number },
): TokenRefreshSchedule {
  const refreshAtMs = expiresAt - skewMs;
  return {
    refreshAtMs,
    isExpired: expiresAt <= nowMs,
    remainingMs: Math.max(0, refreshAtMs - nowMs),
  };
}
