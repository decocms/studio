/**
 * Cross-pod stale-while-revalidate cache for the GitHub PR reads behind a task
 * board card, over NATS JetStream KV.
 *
 * This is the upgrade path the per-pod `InMemoryMcpReadCache` in `prs-get.ts`
 * left open: that one worked, but each replica warmed its own copy, so a cold
 * pod (and every pod after a deploy) still blocked the task dialog on a live
 * GitHub round-trip, and N replicas cost N fetches per window against the same
 * secondary rate limit the cache exists to dodge. KV makes one fetch serve every
 * replica, and survives a restart.
 *
 * Semantics match the in-memory cache it replaces: a hit returns immediately;
 * past `revalidateAfterMs` the stored value is served while ONE background
 * fetch refreshes it; past `maxStaleMs` the caller blocks on a live fetch. The
 * single-flight guard is per-pod, so a stampede across replicas can still cost
 * one fetch per replica — bounded, and far below the per-viewer fetch it
 * replaces.
 *
 * Best-effort throughout: no NATS, a cold bucket, an oversized value or a decode
 * failure all fall back to the in-memory cache, which is also what development
 * (no NATS) runs on. Mirrors {@link ../../mcp-clients/mcp-list-cache.ts}.
 */

import { createHash } from "node:crypto";
import { type JetStreamClient, StorageType } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import { InMemoryMcpReadCache } from "../../mcp-clients/mcp-read-cache";
import { jsonCodec } from "../../nats/json-codec";
import { meter } from "../../observability";

const cacheCounter = meter.createCounter("pr_read_cache.fetches", {
  description: "Task board PR read cache outcomes (hit, stale, miss, error)",
  unit: "{fetches}",
});

const KV_BUCKET = "DECOCMS_PR_READS";

/** Just under the dialog's 60s poll, so a poll refreshes rather than blocks. */
const REVALIDATE_AFTER_MS = 55_000;
/** How long a rate-limit window may be papered over with the last good read. */
const MAX_STALE_MS = 30 * 60_000;
const MAX_VALUE_BYTES = 512 * 1024;

const FALLBACK_ENTRY = {
  revalidateAfterMs: REVALIDATE_AFTER_MS,
  maxStaleMs: MAX_STALE_MS,
  maxValueBytes: MAX_VALUE_BYTES,
} as const;

interface StoredRead {
  storedAt: number;
  value: unknown;
}

export interface PrReadCacheFetch {
  connectionId: string;
  name: string;
  args: Record<string, unknown>;
  /** MUST reject (not return) on error, so a failure is never stored. */
  fetchLive: () => Promise<unknown>;
  /** Receives the background revalidation so the caller can keep its MCP client
   *  open until it settles. */
  onRevalidation: (promise: Promise<void>) => void;
}

export class JetStreamKVPrReadCache {
  private kv: KV | null = null;
  private readonly codec = jsonCodec<StoredRead>();
  /** Keys with an in-flight background revalidation on THIS pod. */
  private readonly revalidating = new Set<string>();
  /** Used whenever KV is unavailable — development, or NATS not yet ready. */
  private readonly fallback = new InMemoryMcpReadCache({
    "tools/call": FALLBACK_ENTRY,
    "resources/read": FALLBACK_ENTRY,
    "prompts/get": FALLBACK_ENTRY,
  });

  constructor(
    private readonly options: { getJetStream: () => JetStreamClient | null },
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** @param kv Test seam: use this bucket instead of opening the real one. */
  async init(kv?: KV): Promise<void> {
    if (kv) {
      this.kv = kv;
      return;
    }
    const js = this.options.getJetStream();
    if (!js) return; // NATS not ready — fall back until re-init
    this.kv = await new Kvm(js).create(KV_BUCKET, {
      storage: StorageType.Memory,
      ttl: MAX_STALE_MS,
      maxValueSize: MAX_VALUE_BYTES,
    });
  }

  /**
   * KV keys allow only `[-/_=.a-zA-Z0-9]`, and the tool arguments carry braces
   * and quotes — so the call is hashed. The connection id stays a readable
   * prefix because `invalidate` deletes by subject filter on it.
   */
  private key(connectionId: string, name: string, args: unknown): string {
    const digest = createHash("sha256")
      .update(JSON.stringify({ name, args }))
      .digest("hex")
      .slice(0, 32);
    return `${connectionId}.${digest}`;
  }

  async fetch(params: PrReadCacheFetch): Promise<unknown> {
    const { connectionId, name, args, fetchLive, onRevalidation } = params;
    if (!this.kv) {
      return this.fallback.fetch({
        type: "tools/call",
        connectionId,
        // The GitHub installation is the connection's, not the caller's, so
        // every org member reading the same PR shares one entry.
        scope: { kind: "org" },
        params: { name, arguments: args },
        fetchLive,
        onRevalidation,
      });
    }

    const key = this.key(connectionId, name, args);
    const stored = await this.read(key);
    const age = stored
      ? this.now() - stored.storedAt
      : Number.POSITIVE_INFINITY;

    if (!stored || age > MAX_STALE_MS) {
      cacheCounter.add(1, { outcome: "miss" });
      const value = await fetchLive();
      await this.write(key, value);
      return value;
    }

    if (age > REVALIDATE_AFTER_MS && !this.revalidating.has(key)) {
      cacheCounter.add(1, { outcome: "stale" });
      this.revalidating.add(key);
      onRevalidation(
        fetchLive()
          .then((value) => this.write(key, value))
          .catch(() => {
            // Best-effort: keep serving the stored value until MAX_STALE_MS.
            cacheCounter.add(1, { outcome: "error" });
          })
          .finally(() => this.revalidating.delete(key)),
      );
    } else {
      cacheCounter.add(1, { outcome: "hit" });
    }

    return stored.value;
  }

  private async read(key: string): Promise<StoredRead | null> {
    try {
      const entry = await this.kv?.get(key);
      if (!entry?.value?.length) return null;
      if (entry.operation === "DEL" || entry.operation === "PURGE") return null;
      return this.codec.decode(entry.value);
    } catch {
      return null; // a decode/read failure is a miss
    }
  }

  private async write(key: string, value: unknown): Promise<void> {
    try {
      await this.kv?.put(
        key,
        this.codec.encode({ storedAt: this.now(), value }),
      );
    } catch {
      // Oversized or NATS hiccup — best-effort, the next read refetches.
    }
  }

  /** Drop this connection's cached PR reads (its config, auth or PR state
   *  changed — see `invalidatePrReads`). */
  async invalidate(connectionId: string): Promise<void> {
    this.fallback.invalidate(connectionId);
    if (!this.kv) return;
    try {
      const keys = await this.kv.keys(`${connectionId}.*`);
      for await (const key of keys) {
        await this.kv.delete(key).catch(() => {});
      }
    } catch {
      // best-effort: the TTL is the backstop.
    }
  }

  teardown(): void {
    this.kv = null;
  }
}

// Module-level active cache — set once at app startup, like the other KV caches.
let activeCache: JetStreamKVPrReadCache | null = null;

export function setPrReadCache(cache: JetStreamKVPrReadCache | null): void {
  activeCache = cache;
}

/**
 * Never null: without NATS (development, or a deployment with the cache off)
 * this is an instance whose KV never initializes, which is exactly the per-pod
 * in-memory cache this file replaced. Call sites don't branch.
 */
const INERT_CACHE = new JetStreamKVPrReadCache({ getJetStream: () => null });

export function getPrReadCache(): JetStreamKVPrReadCache {
  return activeCache ?? INERT_CACHE;
}
