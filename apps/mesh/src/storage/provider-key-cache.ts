/**
 * Provider Key Cache
 *
 * Caches resolved AI provider keys so the hot `AIProviderKeyStorage.resolve`
 * path (one indexed lookup + decrypt per chat/activate request) can skip the
 * database. The cache holds the *encrypted* key plus its metadata — never
 * plaintext — so decryption still happens per call and decrypted secrets stay
 * request-scoped rather than lingering in a long-lived process heap.
 *
 * Cross-replica correctness matters here because keys can be deleted (revoked)
 * or rotated. On any mutation we evict locally AND broadcast the invalidation
 * over NATS so the other replicas drop their copies near-instantly. The TTL is
 * the worst-case floor: if NATS is mid-hiccup and a broadcast is lost, every
 * replica still re-reads from the DB within `ttlMs`. Keep it short.
 */

import type { NatsConnection, Subscription } from "nats";
import { createTtlLruCache, type TtlLruCache } from "../lib/ttl-lru-cache";
import type { ProviderKeyInfo } from "./types";

export interface ProviderKeyCacheEntry {
  keyInfo: ProviderKeyInfo;
  encryptedApiKey: string;
}

export interface ProviderKeyCache {
  get(organizationId: string, keyId: string): ProviderKeyCacheEntry | undefined;
  set(
    organizationId: string,
    keyId: string,
    entry: ProviderKeyCacheEntry,
  ): void;
  /** Evict locally and broadcast the invalidation to other replicas. */
  invalidate(organizationId: string, keyId: string): void;
  /** Subscribe to remote invalidations. Idempotent; call once after NATS is ready. */
  start(): void;
  teardown(): void;
}

const INVALIDATE_SUBJECT = "studio.ai-provider-keys.invalidate";
const DEFAULT_TTL_MS = 30_000; // short: this is the worst-case revocation floor
const DEFAULT_MAX_SIZE = 5_000;

function cacheKey(organizationId: string, keyId: string): string {
  return `${organizationId}:${keyId}`;
}

export interface ProviderKeyCacheOptions {
  ttlMs?: number;
  maxSize?: number;
  /** Returns the shared NATS connection, or null when unavailable (local-only mode). */
  getConnection?: () => NatsConnection | null;
}

export function createProviderKeyCache(
  options?: ProviderKeyCacheOptions,
): ProviderKeyCache {
  const cache: TtlLruCache<ProviderKeyCacheEntry> =
    createTtlLruCache<ProviderKeyCacheEntry>({
      ttlMs: options?.ttlMs ?? DEFAULT_TTL_MS,
      maxSize: options?.maxSize ?? DEFAULT_MAX_SIZE,
    });
  const getConnection = options?.getConnection;
  const originId = crypto.randomUUID();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let sub: Subscription | null = null;

  function publishInvalidation(organizationId: string, keyId: string): void {
    const nc = getConnection?.();
    if (!nc) return; // NATS not ready — local eviction only, TTL covers the rest
    try {
      nc.publish(
        INVALIDATE_SUBJECT,
        encoder.encode(JSON.stringify({ organizationId, keyId, originId })),
      );
    } catch (err) {
      console.warn("[ProviderKeyCache] Publish failed (non-critical):", err);
    }
  }

  return {
    get(organizationId, keyId) {
      return cache.get(cacheKey(organizationId, keyId));
    },

    set(organizationId, keyId, entry) {
      cache.set(cacheKey(organizationId, keyId), entry);
    },

    invalidate(organizationId, keyId) {
      cache.delete(cacheKey(organizationId, keyId));
      publishInvalidation(organizationId, keyId);
    },

    start() {
      if (sub) return;
      const nc = getConnection?.();
      if (!nc) return; // re-attempted on the next NATS-ready callback
      sub = nc.subscribe(INVALIDATE_SUBJECT);
      (async () => {
        for await (const msg of sub!) {
          try {
            const parsed = JSON.parse(decoder.decode(msg.data)) as {
              organizationId: string;
              keyId: string;
              originId?: string;
            };
            if (parsed.originId === originId) continue; // our own broadcast
            cache.delete(cacheKey(parsed.organizationId, parsed.keyId));
          } catch {
            // Ignore malformed messages
          }
        }
      })().catch(console.error);
    },

    teardown() {
      sub?.unsubscribe();
      sub = null;
      cache.clear();
    },
  };
}
