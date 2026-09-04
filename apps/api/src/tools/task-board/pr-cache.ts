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
  description:
    "Task board PR cache outcomes (hit, stale, miss, placeholder, error, store_rejected)",
  unit: "{fetches}",
});

const MAX_VALUE_BYTES = 512 * 1024;

export interface PrCacheConfig {
  /** KV bucket. One per cache so `invalidate` can't cross them. */
  bucket: string;
  /** Serve the stored value and refresh it in the background past this age. */
  revalidateAfterMs: number;
  /** Past this age a stored value is a miss — block on a live fetch instead. */
  maxStaleMs: number;
  /** Label on this cache's metrics, so the two are separable in Grafana. */
  cache: string;
}

/** The raw GitHub reads. Serves the sweeps and a cold card. */
export const PR_READS_CACHE: PrCacheConfig = {
  bucket: "DECOCMS_PR_READS",
  /** Just under the dialog's 60s poll, so a poll refreshes rather than blocks. */
  revalidateAfterMs: 55_000,
  /** How long a rate-limit window may be papered over with the last good read. */
  maxStaleMs: 30 * 60_000,
  cache: "reads",
};

/**
 * The ASSEMBLED cards for one task — the thing the dialog actually renders.
 *
 * This sits in front of the read cache because the read cache was the wrong
 * granularity to make a page refresh fast. It stores raw GitHub payloads, and
 * `get_comments` on a busy PR runs past `MAX_VALUE_BYTES`; the put is rejected
 * and that PR then misses on EVERY read, forever, so the card blocked on
 * GitHub every time. In prod that showed up as 922 misses to 81 hits in an
 * hour.
 *
 * A card is a few hundred bytes, so it always stores, and one KV get replaces
 * the four-to-six this used to make per PR.
 *
 * `maxStaleMs` is a day rather than half an hour on purpose: past it the card
 * BLOCKS again, and a card that was rendered once should never make someone
 * wait on GitHub a second time. Stale is still refreshed on every poll.
 */
export const PR_CARDS_CACHE: PrCacheConfig = {
  bucket: "DECOCMS_PR_CARDS",
  /** Under the dialog's 60s poll, so a poll refreshes rather than blocks. */
  revalidateAfterMs: 30_000,
  maxStaleMs: 24 * 60 * 60_000,
  cache: "cards",
};

interface StoredRead {
  storedAt: number;
  value: unknown;
}

export interface PrCacheFetch {
  /** Prefix `invalidate` deletes by — a connection id, or an organization id. */
  namespace: string;
  /** Identifies the value within the namespace; hashed if it isn't KV-safe. */
  key: string;
  /** MUST reject (not return) on error, so a failure is never stored. */
  fetchLive: () => Promise<unknown>;
  /** Receives the background revalidation so the caller can keep its MCP client
   *  open until it settles. */
  onRevalidation: (promise: Promise<void>) => void;
  /** Per-entry override of the hit window, computed from the STORED value.
   *  A read whose value says "not ready yet" — a deploy with no url published —
   *  should go stale fast, so the next poll refetches instead of serving the
   *  not-ready answer for the full config window. Omit for the default. */
  revalidateAfterMs?: (stored: unknown) => number;
}

export class JetStreamKVPrCache {
  private kv: KV | null = null;
  private readonly codec = jsonCodec<StoredRead>();
  /** Keys with an in-flight background revalidation on THIS pod. */
  private readonly revalidating = new Set<string>();
  /** Used whenever KV is unavailable — development, or NATS not yet ready. */
  private readonly fallback: InMemoryMcpReadCache;
  /**
   * Backs {@link fetchOrPlaceholder} whenever KV is unavailable. `fallback`
   * (above) can't serve that method: it has no notion of "return a placeholder
   * without blocking", so without this a NATS outage silently turned
   * `fetchOrPlaceholder`'s documented never-blocks guarantee into a synchronous
   * `fetchLive()` — exactly the GitHub round-trip the card cache exists to
   * remove from the request path. Capped so a sustained outage can't grow it
   * unbounded.
   */
  private readonly placeholderFallback = new Map<string, StoredRead>();
  private static readonly MAX_PLACEHOLDER_FALLBACK_ENTRIES = 1000;

  constructor(
    private readonly config: PrCacheConfig,
    private readonly options: { getJetStream: () => JetStreamClient | null },
    private readonly now: () => number = () => Date.now(),
  ) {
    const entry = {
      revalidateAfterMs: config.revalidateAfterMs,
      maxStaleMs: config.maxStaleMs,
      maxValueBytes: MAX_VALUE_BYTES,
    };
    this.fallback = new InMemoryMcpReadCache({
      "tools/call": entry,
      "resources/read": entry,
      "prompts/get": entry,
    });
  }

  /** @param kv Test seam: use this bucket instead of opening the real one. */
  async init(kv?: KV): Promise<void> {
    if (kv) {
      this.kv = kv;
      return;
    }
    const js = this.options.getJetStream();
    if (!js) return; // NATS not ready — fall back until re-init
    this.kv = await new Kvm(js).create(this.config.bucket, {
      storage: StorageType.Memory,
      ttl: this.config.maxStaleMs,
      maxValueSize: MAX_VALUE_BYTES,
    });
  }

  /**
   * KV keys allow only `[-/_=.a-zA-Z0-9]`, so anything else in `key` is hashed
   * away. The namespace stays a readable prefix because `invalidate` deletes by
   * subject filter on it.
   */
  private storageKey(namespace: string, key: string): string {
    const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
    return `${namespace}.${digest}`;
  }

  async fetch(params: PrCacheFetch): Promise<unknown> {
    const { namespace, key: rawKey, fetchLive, onRevalidation } = params;
    const { cache, maxStaleMs } = this.config;
    const defaultRevalidateAfterMs = this.config.revalidateAfterMs;
    if (!this.kv) {
      return this.fallback.fetch({
        type: "tools/call",
        connectionId: namespace,
        // The GitHub installation is the connection's, not the caller's, so
        // every org member reading the same PR shares one entry.
        scope: { kind: "org" },
        params: { key: rawKey },
        fetchLive,
        onRevalidation,
      });
    }

    const key = this.storageKey(namespace, rawKey);
    const stored = await this.read(key);
    const age = stored
      ? this.now() - stored.storedAt
      : Number.POSITIVE_INFINITY;

    if (!stored || age > maxStaleMs) {
      cacheCounter.add(1, { cache, outcome: "miss" });
      const value = await fetchLive();
      await this.write(key, value, cache);
      return value;
    }

    const revalidateAfterMs = params.revalidateAfterMs
      ? params.revalidateAfterMs(stored.value)
      : defaultRevalidateAfterMs;
    if (age > revalidateAfterMs && !this.revalidating.has(key)) {
      cacheCounter.add(1, { cache, outcome: "stale" });
      this.revalidating.add(key);
      onRevalidation(
        fetchLive()
          .then((value) => this.write(key, value, cache))
          .catch(() => {
            // Best-effort: keep serving the stored value until maxStaleMs.
            cacheCounter.add(1, { cache, outcome: "error" });
          })
          .finally(() => this.revalidating.delete(key)),
      );
    } else {
      cacheCounter.add(1, { cache, outcome: "hit" });
    }

    return stored.value;
  }

  /**
   * Like {@link fetch}, but it NEVER blocks: with nothing stored it returns
   * `placeholder` and starts the fetch in the background, so the next poll gets
   * the real thing.
   *
   * For the task card, the placeholder is what the database already knows —
   * which repo, which number, the link. Making someone watch a skeleton while
   * GitHub is asked for the title is a self-inflicted wait: the part of the
   * card that needs GitHub can arrive late without holding back the part that
   * doesn't.
   *
   * `live` says whether the value came from a real read. Callers that act on
   * the card (the reconciles) must skip on `false` — "we have not asked GitHub
   * yet" is not the same as "GitHub says there are no checks".
   */
  async fetchOrPlaceholder<T>(params: {
    namespace: string;
    key: string;
    fetchLive: () => Promise<T>;
    placeholder: T;
    /** Per-entry override of the hit window, computed from the STORED value —
     *  see {@link PrCacheFetch.revalidateAfterMs}. */
    revalidateAfterMs?: (stored: T) => number;
  }): Promise<{ value: T; live: boolean }> {
    const { namespace, key: rawKey, fetchLive, placeholder } = params;
    const { cache, maxStaleMs } = this.config;
    const key = this.storageKey(namespace, rawKey);
    const stored = await this.read(key);
    const age = stored
      ? this.now() - stored.storedAt
      : Number.POSITIVE_INFINITY;
    const usable = stored != null && age <= maxStaleMs;
    const revalidateAfterMs =
      stored && params.revalidateAfterMs
        ? params.revalidateAfterMs(stored.value as T)
        : this.config.revalidateAfterMs;

    if (usable && age <= revalidateAfterMs) {
      cacheCounter.add(1, { cache, outcome: "hit" });
      return { value: stored.value as T, live: true };
    }

    cacheCounter.add(1, {
      cache,
      outcome: usable ? "stale" : "placeholder",
    });
    if (!this.revalidating.has(key)) {
      this.revalidating.add(key);
      // Detached: the wait is the thing being removed. The result lands in KV
      // for the next poll, which is seconds away while the card is unenriched.
      void fetchLive()
        .then((value) => this.write(key, value, cache))
        .catch(() => {
          cacheCounter.add(1, { cache, outcome: "error" });
        })
        .finally(() => this.revalidating.delete(key));
    }

    return usable
      ? { value: stored!.value as T, live: true }
      : { value: placeholder, live: false };
  }

  private async read(key: string): Promise<StoredRead | null> {
    if (!this.kv) return this.placeholderFallback.get(key) ?? null;
    try {
      const entry = await this.kv?.get(key);
      if (!entry?.value?.length) return null;
      if (entry.operation === "DEL" || entry.operation === "PURGE") return null;
      return this.codec.decode(entry.value);
    } catch {
      return null; // a decode/read failure is a miss
    }
  }

  private async write(
    key: string,
    value: unknown,
    cache: string,
  ): Promise<void> {
    if (!this.kv) {
      // Evict the oldest entry (insertion order) once past the cap.
      if (
        this.placeholderFallback.size >=
        JetStreamKVPrCache.MAX_PLACEHOLDER_FALLBACK_ENTRIES
      ) {
        const oldest = this.placeholderFallback.keys().next().value;
        if (oldest !== undefined) this.placeholderFallback.delete(oldest);
      }
      this.placeholderFallback.set(key, { storedAt: this.now(), value });
      return;
    }
    try {
      await this.kv?.put(
        key,
        this.codec.encode({ storedAt: this.now(), value }),
      );
    } catch {
      // Oversized, or a NATS hiccup. Counted, not swallowed: a value the bucket
      // keeps rejecting never caches, so that key misses on every single read
      // forever — silently, and indistinguishably from a cold cache. That is
      // what this counter exists to make visible.
      cacheCounter.add(1, { cache, outcome: "store_rejected" });
    }
  }

  /** Drop everything cached under `namespace` — a connection whose config, auth
   *  or PR state changed, or an organization whose card must be re-read. */
  async invalidate(namespace: string): Promise<void> {
    this.fallback.invalidate(namespace);
    if (!this.kv) return;
    try {
      const keys = await this.kv.keys(`${namespace}.*`);
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

// Module-level active caches — set once at app startup, like the other KV caches.
let activeReadCache: JetStreamKVPrCache | null = null;
let activeCardCache: JetStreamKVPrCache | null = null;

export function setPrCaches(
  caches: { reads: JetStreamKVPrCache; cards: JetStreamKVPrCache } | null,
): void {
  activeReadCache = caches?.reads ?? null;
  activeCardCache = caches?.cards ?? null;
}

/**
 * Never null: without NATS (development, or a deployment with the cache off)
 * these are instances whose KV never initializes, which is exactly the per-pod
 * in-memory cache this file replaced. Call sites don't branch.
 */
const INERT_READS = new JetStreamKVPrCache(PR_READS_CACHE, {
  getJetStream: () => null,
});
const INERT_CARDS = new JetStreamKVPrCache(PR_CARDS_CACHE, {
  getJetStream: () => null,
});

export function getPrReadCache(): JetStreamKVPrCache {
  return activeReadCache ?? INERT_READS;
}

export function getPrCardCache(): JetStreamKVPrCache {
  return activeCardCache ?? INERT_CARDS;
}
