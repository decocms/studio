/**
 * Per-pod cache for a Virtual MCP's *aggregated* tool list.
 *
 * The virtual-MCP HTTP route runs its transport stateless: a fresh
 * `PassthroughClient` is built per request, so `GatewayClient`'s own
 * `toolsCache` dies with the request and every `tools/list` re-runs the whole
 * fan-out. That is fine once; it is not fine at the rate clients actually poll
 * it — an MCP client that fails to connect re-initializes every ~13s, and each
 * cycle repays the full aggregation for a tool list that cannot have changed.
 *
 * The per-connection list cache (`mcp-list-cache`, NATS KV) already spares the
 * downstream MCP handshake. What it cannot spare is the aggregate itself: one
 * KV round trip per child, plus namespacing/filtering every tool of every
 * child. This closes that gap.
 *
 * Correctness rules this cache lives by:
 *
 * - **Keyed per acting user.** A child connection can resolve a different tool
 *   set per user (its own OAuth token decides), so an org-wide entry would leak
 *   one member's tools to another. The key carries the user id; the cost is a
 *   lower hit rate, which is the right trade.
 * - **Keyed by the full child set**, so a dev-sandbox connection grafted onto
 *   the agent for one user never aliases the plain agent.
 * - **TTL + cap**, so a stale or unbounded entry cannot outlive its usefulness.
 * - **Invalidated by connection id** through the existing cross-replica
 *   connection-cache eviction, so a connection or agent edit is reflected
 *   immediately on every pod rather than after the TTL.
 */

import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { meter } from "../../observability";

/**
 * How long an aggregate may be served without revalidation. Matches
 * `REVALIDATE_MIN_INTERVAL_MS` in `mcp-list-cache` — that is already the floor
 * on how fresh a child's tool list is, so a shorter TTL here would buy nothing
 * but work. Connection edits do not wait for it (see `invalidateAggregates`).
 */
const TTL_MS = 30_000;

/**
 * Max concurrently cached aggregates. One entry per (agent, user, child set);
 * an entry is a tool list, so this is the memory knob. Oldest-inserted is
 * evicted first — a Map preserves insertion order, and re-inserting on write
 * keeps that order meaningful.
 */
const MAX_ENTRIES = 500;

interface Entry {
  /** Insertion time, for TTL. */
  at: number;
  /** Connection ids this aggregate was built from, for targeted invalidation. */
  deps: readonly string[];
  /**
   * The in-flight or settled aggregation. Storing the promise (not the value)
   * collapses a concurrent burst of identical requests into one fan-out; a
   * rejection removes itself so a failure is never cached.
   */
  value: Promise<ListToolsResult>;
}

const cache = new Map<string, Entry>();

/**
 * Instruments, registered lazily on first use.
 *
 * `meter` is a live binding that is a Noop until `initObservability()` swaps it
 * in after SDK start, so an instrument captured at module load would report to
 * the Noop forever — which is exactly the failure mode that makes a cache
 * un-debuggable. Registering on first lookup guarantees the real meter is in
 * place (traffic is what triggers it).
 *
 * What each answers:
 * - `lookups{outcome}` — is this cache doing anything? The storage is per-pod
 *   and prod fans a client's requests across 6 API processes, so the hit rate
 *   is the number that decides whether the per-user key is too narrow or the
 *   30s TTL too short.
 * - `entries` — is the 500 cap saturating (i.e. is it evicting live entries)?
 * - `evictions{reason}` — how much of the churn is the cap vs. genuine
 *   invalidation vs. failed aggregations.
 */
let lookups: ReturnType<typeof meter.createCounter> | null = null;
let evictions: ReturnType<typeof meter.createCounter> | null = null;
let metricsRegistered = false;

function ensureMetrics(): void {
  if (metricsRegistered) return;
  metricsRegistered = true;
  try {
    lookups = meter.createCounter("virtual_mcp.aggregate_cache.lookups", {
      description:
        "Virtual MCP aggregate tool-list cache lookups by outcome (hit, miss, expired)",
      unit: "{lookups}",
    });
    evictions = meter.createCounter("virtual_mcp.aggregate_cache.evictions", {
      description:
        "Virtual MCP aggregate tool-list cache entries dropped, by reason (capacity, invalidated, failed)",
      unit: "{entries}",
    });
    meter
      .createObservableGauge("virtual_mcp.aggregate_cache.entries", {
        description:
          "Live entries in this pod's Virtual MCP aggregate tool-list cache",
        unit: "{entries}",
      })
      .addCallback((r) => r.observe(cache.size));
  } catch (err) {
    console.error("[aggregate-cache] failed to register metrics:", err);
  }
}

function recordLookup(outcome: "hit" | "miss" | "expired"): void {
  ensureMetrics();
  lookups?.add(1, { outcome });
}

function recordEviction(
  reason: "capacity" | "invalidated" | "failed",
  count = 1,
): void {
  if (count <= 0) return;
  ensureMetrics();
  evictions?.add(count, { reason });
}

/**
 * Cache key for one aggregation. Every input that can change the resulting
 * tool list has to appear here: the agent (its `selected_tools` config), the
 * acting user (per-user downstream tokens), the superuser bypass, and the exact
 * child connection set (which includes any grafted dev-sandbox connection).
 */
export function aggregateCacheKey(parts: {
  virtualMcpId: string | null | undefined;
  userId: string | null | undefined;
  superUser: boolean;
  connectionIds: readonly string[];
}): string {
  // Fields sit at fixed positions joined by "|", which no id contains, so an
  // absent field is the empty string rather than a placeholder word — a
  // placeholder like "anon" is itself a syntactically valid id and would alias
  // a real principal onto the anonymous slot.
  return [
    parts.virtualMcpId ?? "",
    parts.userId ?? "",
    parts.superUser ? "su" : "",
    [...parts.connectionIds].sort().join(","),
  ].join("|");
}

/** A live (non-expired) aggregate for `key`, or null. */
export function getCachedAggregate(
  key: string,
): Promise<ListToolsResult> | null {
  const entry = cache.get(key);
  if (!entry) {
    recordLookup("miss");
    return null;
  }
  if (Date.now() - entry.at >= TTL_MS) {
    cache.delete(key);
    recordLookup("expired");
    return null;
  }
  recordLookup("hit");
  return entry.value;
}

/**
 * Store an aggregation under `key`. Returns the same promise so callers can
 * `return setCachedAggregate(...)` in one step.
 */
export function setCachedAggregate(
  key: string,
  deps: readonly string[],
  value: Promise<ListToolsResult>,
): Promise<ListToolsResult> {
  // Never cache a failure: a transient aggregation error must not pin an empty
  // tool list for the whole TTL.
  const tracked = value.catch((err: unknown) => {
    if (cache.get(key)?.value === tracked) {
      cache.delete(key);
      recordEviction("failed");
    }
    throw err;
  });

  cache.delete(key); // re-insert so Map order stays newest-last for eviction
  cache.set(key, { at: Date.now(), deps, value: tracked });

  let evicted = 0;
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
    evicted++;
  }
  recordEviction("capacity", evicted);

  return tracked;
}

/**
 * Drop every aggregate that was built from `connectionId` — as a child OR as
 * the agent itself. Called from the connection-cache eviction path, which is
 * already broadcast to every replica, so an agent or connection edit takes
 * effect immediately instead of at TTL.
 */
export function invalidateAggregates(connectionId: string): void {
  let dropped = 0;
  for (const [key, entry] of cache) {
    if (entry.deps.includes(connectionId)) {
      cache.delete(key);
      dropped++;
    }
  }
  recordEviction("invalidated", dropped);
}

/** Drop everything. Tests only. */
export function clearAggregateCache(): void {
  cache.clear();
}
