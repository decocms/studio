import type { ModelInfo } from "./types";
import {
  JSONCodec,
  StorageType,
  type JetStreamClient,
  type KV,
  type NatsConnection,
} from "nats";

export interface ModelListCache {
  get(providerId: string): Promise<ModelInfo[] | null>;
  set(providerId: string, models: ModelInfo[]): Promise<void>;
  invalidate(providerId: string): Promise<void>;
  teardown(): void;
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

  async get(providerId: string): Promise<ModelInfo[] | null> {
    const entry = this.cache.get(providerId);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.cache.delete(providerId);
      return null;
    }
    return entry.models;
  }

  async set(providerId: string, models: ModelInfo[]): Promise<void> {
    this.cache.set(providerId, { models, ts: Date.now() });
  }

  async invalidate(providerId: string): Promise<void> {
    this.cache.delete(providerId);
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

  async get(providerId: string): Promise<ModelInfo[] | null> {
    if (!this.kv) return null;
    try {
      const entry = await this.kv.get(`models.${providerId}`);
      if (!entry?.value?.length) return null;
      if (entry.operation === "DEL" || entry.operation === "PURGE") return null;
      return this.codec.decode(entry.value);
    } catch {
      return null;
    }
  }

  async set(providerId: string, models: ModelInfo[]): Promise<void> {
    if (!this.kv) return;
    try {
      await this.kv.put(`models.${providerId}`, this.codec.encode(models));
    } catch {
      // best-effort
    }
  }

  async invalidate(providerId: string): Promise<void> {
    if (!this.kv) return;
    try {
      await this.kv.delete(`models.${providerId}`);
    } catch {
      // best-effort
    }
  }

  teardown(): void {
    this.kv = null;
    console.log("[ModelListCache] JetStream KV torn down");
  }
}
