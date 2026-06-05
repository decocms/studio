/**
 * Pull-transport canary gate (spec §7 Phase D).
 *
 * Decides whether a thread should use the pull transport (daemon-pull +
 * ingest-post) rather than the default WS remoteDispatch path.
 *
 * INVARIANT (L12): pull ⊆ v2. A thread with message_storage_version < 2
 * MUST NOT be switched to pull regardless of the column or the env var.
 *
 * Bucketing algorithm is identical to v2-canary.ts (FNV-1a, mod 100) so
 * the two canaries advance independently without coupling.
 */

/** FNV-1a hash → 32-bit unsigned, mod 100. Same algorithm as v2-canary. */
function hashToBucket(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}

/** Parse `LINK_PULL_TRANSPORT_PERCENT` into a clamped integer. Missing/invalid → 0. */
export function parsePullPercent(raw: string | undefined): number {
  if (raw == null || raw === "") return 0;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

export interface ShouldUsePullInput {
  /** Thread id — bucketing seed. */
  threadId: string;
  /** Thread's `message_storage_version`. Pull requires v2 (value >= 2). */
  messageStorageVersion: number;
  /** Explicit column value. null = decide by canary; 'ws' = force WS; 'pull' = force pull. */
  linkTransport: "pull" | "ws" | null;
  /** Resolved canary percent (0–100). Typically from `parsePullPercent(env)`. */
  percent: number;
}

/**
 * Return true if this thread should use the pull transport.
 *
 * Pure function — no env reads, no DB. Call `parsePullPercent(env)` at the
 * call site and pass the result as `percent`.
 */
export function shouldUsePullTransport(input: ShouldUsePullInput): boolean {
  // L12: pull ⊆ v2 — hard gate, never bypassed.
  if (input.messageStorageVersion < 2) return false;

  // Explicit column overrides canary.
  if (input.linkTransport === "ws") return false;
  if (input.linkTransport === "pull") return true;

  // null: fall through to canary bucketing.
  if (input.percent <= 0) return false;
  if (input.percent >= 100) return true;
  return hashToBucket(input.threadId) < input.percent;
}
