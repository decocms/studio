/**
 * Cross-replica invalidation for the per-pod MCP caches.
 *
 * The read-content cache (mcp-read-cache) and tool-result cache
 * (mcp-result-cache) are in-memory per-pod singletons, so evicting them locally
 * only clears the pod that handled the mutation — every other replica keeps
 * serving stale (possibly now-unauthorized) responses until TTL. On a
 * connection change we therefore evict locally AND broadcast over NATS so the
 * other replicas drop their copies near-instantly. TTL is the worst-case floor:
 * if NATS is mid-hiccup and a broadcast is lost, each replica still expires the
 * entry within its TTL.
 *
 * (The tool/resource/prompt *list* cache is NATS JetStream KV — already
 * cross-pod — so it is invalidated directly by its callers, not here.)
 */

import type { NatsConnection, Subscription } from "@nats-io/nats-core";
import { getMcpReadCache } from "./mcp-read-cache";

const INVALIDATE_SUBJECT = "studio.mcp-cache.invalidate";

const originId = crypto.randomUUID();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let getConnection: (() => NatsConnection | null) | undefined;
let sub: Subscription | null = null;

/** Drop this connection's per-pod cached read results (content + tool calls). */
function evictLocal(connectionId: string): void {
  getMcpReadCache()?.invalidate(connectionId);
}

/**
 * Evict this connection's per-pod caches on every replica: locally now, and on
 * the others via a NATS broadcast. Falls back to local-only (covered by TTL)
 * when NATS is unavailable — e.g. single-pod local mode.
 */
export function invalidateConnectionCaches(connectionId: string): void {
  evictLocal(connectionId);
  const nc = getConnection?.();
  if (!nc) return; // NATS not ready — local eviction only, TTL covers the rest
  try {
    nc.publish(
      INVALIDATE_SUBJECT,
      encoder.encode(JSON.stringify({ connectionId, originId })),
    );
  } catch (err) {
    console.warn("[McpCacheInvalidation] publish failed (non-critical):", err);
  }
}

/**
 * Subscribe to cross-replica invalidations. Idempotent; call once after NATS is
 * ready (re-attempted on each NATS-ready callback).
 */
export function startMcpCacheInvalidation(
  getConn: () => NatsConnection | null,
): void {
  getConnection = getConn;
  if (sub) return;
  const nc = getConn();
  if (!nc) return; // retried on the next NATS-ready callback
  sub = nc.subscribe(INVALIDATE_SUBJECT);
  (async () => {
    for await (const msg of sub!) {
      try {
        const parsed = JSON.parse(decoder.decode(msg.data)) as {
          connectionId: string;
          originId?: string;
        };
        if (parsed.originId === originId) continue; // our own broadcast
        evictLocal(parsed.connectionId);
      } catch {
        // Ignore malformed messages
      }
    }
  })().catch(console.error);
}

export function teardownMcpCacheInvalidation(): void {
  sub?.unsubscribe();
  sub = null;
  getConnection = undefined;
}
