/**
 * Stream-of-record v2 write-path canary.
 *
 * SAFETY: the v2 (`thread_message_parts`) write path is gated behind this
 * predicate, which DEFAULTS OFF. No existing thread becomes v2 — the pin is
 * only ever applied to a brand-new thread (no prior messages) at its
 * first-message site, and only when this predicate says yes. When off, the
 * thread keeps `message_storage_version = 1` and the v1 path runs byte-for-byte
 * unchanged.
 *
 * The rollout knob is the env var `STREAM_OF_RECORD_V2_PERCENT` — an integer
 * 0–100. `"0"` (the default) means never; `"100"` means always. Anything in
 * between selects a deterministic, stable-per-thread slice so the same thread
 * id always resolves the same way (a re-evaluation can't flip a thread between
 * v1 and v2).
 */

/**
 * FNV-1a hash → 32-bit unsigned. Deterministic, fast, no crypto. Used only to
 * spread thread ids uniformly across the 0–99 bucket space; not security
 * sensitive.
 */
function hashToBucket(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 → unsigned; mod 100 → bucket in [0, 99].
  return (h >>> 0) % 100;
}

/**
 * Parse `STREAM_OF_RECORD_V2_PERCENT` into a clamped integer percent. Invalid
 * / missing / negative → 0 (off). >100 → 100. Keeps the call site dead simple.
 */
export function parseV2Percent(raw: string | undefined): number {
  if (raw == null) return 0;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * Decide whether a brand-new thread should be pinned to v2.
 *
 * @param threadId - the thread id (the deterministic bucketing seed).
 * @param percent  - resolved rollout percent (0–100); typically
 *                   `parseV2Percent(process.env.STREAM_OF_RECORD_V2_PERCENT)`.
 */
export function shouldPinV2(threadId: string, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  // bucket < percent → in the canary slice. With percent=10, buckets 0–9
  // (≈10% of ids) are selected, and a given id's bucket never changes.
  return hashToBucket(threadId) < percent;
}

/**
 * Convenience wrapper that reads the env var directly. The pure two-arg
 * `shouldPinV2` is what the unit tests exercise; this is the call-site form.
 */
export function shouldPinV2FromEnv(threadId: string): boolean {
  return shouldPinV2(
    threadId,
    parseV2Percent(process.env.STREAM_OF_RECORD_V2_PERCENT),
  );
}
