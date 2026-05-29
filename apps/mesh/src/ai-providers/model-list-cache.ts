import { createTtlLruCache, type TtlLruCache } from "../lib/ttl-lru-cache";
import type { ModelInfo } from "./types";

export interface ModelListCache {
  get(organizationId: string, providerId: string): Promise<ModelInfo[] | null>;
  set(
    organizationId: string,
    providerId: string,
    models: ModelInfo[],
  ): Promise<void>;
  invalidate(organizationId: string, providerId: string): Promise<void>;
  teardown(): void;
}

function cacheKey(organizationId: string, providerId: string): string {
  return `${organizationId}.${providerId}`;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_SIZE = 5_000;

export interface InMemoryModelListCacheOptions {
  ttlMs?: number;
  maxSize?: number;
}

/**
 * Process-local model-list cache.
 *
 * Model lists are public, low-stakes metadata and the previous implementation
 * never invalidated cross-replica — it relied entirely on TTL. A per-replica
 * LRU gives the same TTL-bounded staleness with no NATS round-trip per hit, at
 * the cost of each replica fetching upstream independently on a cold miss
 * (acceptable for provider model-list endpoints).
 */
export class InMemoryModelListCache implements ModelListCache {
  private readonly cache: TtlLruCache<ModelInfo[]>;

  constructor(options?: InMemoryModelListCacheOptions) {
    this.cache = createTtlLruCache<ModelInfo[]>({
      ttlMs: options?.ttlMs ?? DEFAULT_TTL_MS,
      maxSize: options?.maxSize ?? DEFAULT_MAX_SIZE,
    });
  }

  async get(
    organizationId: string,
    providerId: string,
  ): Promise<ModelInfo[] | null> {
    return this.cache.get(cacheKey(organizationId, providerId)) ?? null;
  }

  async set(
    organizationId: string,
    providerId: string,
    models: ModelInfo[],
  ): Promise<void> {
    this.cache.set(cacheKey(organizationId, providerId), models);
  }

  async invalidate(organizationId: string, providerId: string): Promise<void> {
    this.cache.delete(cacheKey(organizationId, providerId));
  }

  teardown(): void {
    this.cache.clear();
  }
}
