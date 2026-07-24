/**
 * Per-replica tracker for credential-decryption failures.
 *
 * A connection whose `connection_token` or `configuration_state` ciphertext can't
 * be authenticated ("Unsupported state or unable to authenticate data") fails
 * deterministically — the same vault key never recovers. Left alone it spams the
 * log on every read path. After CONNECTION_DECRYPT_DISABLE_THRESHOLD consecutive
 * failures the connection is durably disabled (status="error"); this tracker
 * dampens the count and suppresses repeat logs until then.
 *
 * Unlike ./mcp-clients/connection-circuit-store, this needs no cross-replica
 * aggregation: a decrypt failure trips on every read on every replica, so each
 * replica reaches the threshold on its own. It is intentionally NOT self-healing
 * — a disabled connection requires manual re-enable.
 */

import {
  CIRCUIT_BREAKER_MAX_ENTRIES,
  CONNECTION_DECRYPT_DISABLE_THRESHOLD,
} from "../core/constants";

interface DecryptFailureEntry {
  consecutiveFailures: number;
  disabled: boolean;
  lastFailureAt: number;
}

const entries = new Map<string, DecryptFailureEntry>();

function evictIfNeeded(): void {
  if (entries.size < CIRCUIT_BREAKER_MAX_ENTRIES) return;
  let oldestId: string | null = null;
  let oldestTime = Infinity;
  for (const [id, entry] of entries) {
    if (entry.lastFailureAt < oldestTime) {
      oldestTime = entry.lastFailureAt;
      oldestId = id;
    }
  }
  if (oldestId) entries.delete(oldestId);
}

/**
 * Record a decrypt failure for a connection. Returns the running consecutive
 * count so the caller can decide whether the disable threshold was crossed.
 */
export function recordDecryptFailure(connectionId: string): {
  consecutiveFailures: number;
  thresholdCrossed: boolean;
} {
  const entry = entries.get(connectionId);
  if (!entry) {
    evictIfNeeded();
    entries.set(connectionId, {
      consecutiveFailures: 1,
      disabled: false,
      lastFailureAt: Date.now(),
    });
    return {
      consecutiveFailures: 1,
      thresholdCrossed: 1 >= CONNECTION_DECRYPT_DISABLE_THRESHOLD,
    };
  }
  entry.consecutiveFailures++;
  entry.lastFailureAt = Date.now();
  return {
    consecutiveFailures: entry.consecutiveFailures,
    thresholdCrossed:
      entry.consecutiveFailures >= CONNECTION_DECRYPT_DISABLE_THRESHOLD,
  };
}

/** Mark a connection as disabled so further failures are suppressed (no log, no re-disable). */
export function markDecryptDisabled(connectionId: string): void {
  const entry = entries.get(connectionId);
  if (entry) {
    entry.disabled = true;
    return;
  }
  evictIfNeeded();
  entries.set(connectionId, {
    consecutiveFailures: CONNECTION_DECRYPT_DISABLE_THRESHOLD,
    disabled: true,
    lastFailureAt: Date.now(),
  });
}

/** True once the connection has been disabled in this replica. */
export function isDecryptDisabled(connectionId: string): boolean {
  return entries.get(connectionId)?.disabled ?? false;
}

/** Clear the failure window after a successful decrypt. Does NOT re-enable a disabled connection. */
export function recordDecryptSuccess(connectionId: string): void {
  entries.delete(connectionId);
}

/** Reset all tracked state. Exposed for testing only. */
export function resetAll(): void {
  entries.clear();
}
