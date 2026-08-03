/**
 * Deterministic Claude Code session id for a Studio thread.
 *
 * The SDK keys its own transcript store by a UUID session id; Studio's thread
 * ids are prefixed (`thrd_…`) and not UUIDs. Deriving the UUID from the thread
 * id — rather than minting one and persisting it — means resuming a thread
 * needs no new column, no round-trip, and no coordination: every turn of a
 * thread computes the same id, so `resume` just works as long as the session
 * file survives (that is what the org-fs mount of `~/.claude` is for).
 *
 * RFC 4122 v5 (SHA-1, name-based) so the value is a real UUID that the SDK
 * accepts, and stable across processes, architectures and releases.
 */

import { createHash } from "node:crypto";

/**
 * Namespace UUID for Studio threads. A fixed random v4 — its only job is to
 * keep this id space from colliding with any other v5 derivation. Never change
 * it: doing so orphans every persisted session.
 */
const STUDIO_THREAD_NAMESPACE = "8f4a1c26-5f7f-4b2e-9a1d-6c3b0e7d2f11";

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

/** UUIDv5 of `name` under `namespace`. */
export function uuidV5(name: string, namespace: string): string {
  const hash = createHash("sha1")
    .update(uuidToBytes(namespace))
    .update(Buffer.from(name, "utf8"))
    .digest();
  // Truncate to 16 bytes, then stamp version (5) and the RFC 4122 variant.
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** The session id this thread's Claude Code transcript lives under. */
export function sessionIdForThread(threadId: string): string {
  return uuidV5(threadId, STUDIO_THREAD_NAMESPACE);
}
