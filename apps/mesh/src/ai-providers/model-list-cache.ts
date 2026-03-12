import type { ModelInfo } from "./types";
import {
  JSONCodec,
  StorageType,
  type JetStreamClient,
  type KV,
  type NatsConnection,
} from "nats";

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

export class InMemoryModelListCache implements ModelListCache {
  private readonly cache = new Map<
    string,
    { models: ModelInfo[]; ts: number }
  >();
  private readonly ttlMs: number;

  constructor(ttlMs = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  async get(
    organizationId: string,
    providerId: string,
  ): Promise<ModelInfo[] | null> {
    const key = cacheKey(organizationId, providerId);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.models;
  }

  async set(
    organizationId: string,
    providerId: string,
    models: ModelInfo[],
  ): Promise<void> {
    this.cache.set(cacheKey(organizationId, providerId), {
      models,
      ts: Date.now(),
    });
  }

  async invalidate(organizationId: string, providerId: string): Promise<void> {
    this.cache.delete(cacheKey(organizationId, providerId));
  }

  teardown(): void {
    this.cache.clear();
  }
}

const KV_BUCKET = "MESH_MODEL_LISTS";
const KV_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface JetStreamKVModelListCacheOptions {
  getJetStream: () => JetStreamClient | null;
  getConnection: () => NatsConnection | null;
}

export class JetStreamKVModelListCache implements ModelListCache {
  private kv: KV | null = null;
  private readonly codec = JSONCodec<ModelInfo[]>();

  constructor(private readonly options: JetStreamKVModelListCacheOptions) {}

  async init(): Promise<void> {
    const nc = this.options.getConnection();
    if (!nc) return;

    const js = this.options.getJetStream();
    if (!js) return;

    try {
      this.kv = await js.views.kv(KV_BUCKET, {
        ttl: KV_TTL_MS,
        storage: StorageType.Memory,
      });
      console.log(
        "[ModelListCache] JetStream KV ready (memory storage, 10min TTL)",
      );
    } catch (err) {
      console.warn(
        "[ModelListCache] JetStream KV init failed, cache disabled:",
        err,
      );
    }
  }

  async get(
    organizationId: string,
    providerId: string,
  ): Promise<ModelInfo[] | null> {
    if (!this.kv) return null;
    try {
      const key = cacheKey(organizationId, providerId);
      const entry = await this.kv.get(`models.${key}`);
      if (!entry?.value?.length) return null;
      if (entry.operation === "DEL" || entry.operation === "PURGE") return null;
      return this.codec.decode(entry.value);
    } catch {
      return null;
    }
  }

  async set(
    organizationId: string,
    providerId: string,
    models: ModelInfo[],
  ): Promise<void> {
    if (!this.kv) return;
    try {
      const key = cacheKey(organizationId, providerId);
      await this.kv.put(`models.${key}`, this.codec.encode(models));
    } catch (err) {
      console.warn("[ModelListCache] set failed:", err);
    }
  }

  async invalidate(organizationId: string, providerId: string): Promise<void> {
    if (!this.kv) return;
    try {
      const key = cacheKey(organizationId, providerId);
      await this.kv.delete(`models.${key}`);
    } catch {
      // best-effort
    }
  }

  teardown(): void {
    this.kv = null;
    console.log("[ModelListCache] JetStream KV torn down");
  }
}
