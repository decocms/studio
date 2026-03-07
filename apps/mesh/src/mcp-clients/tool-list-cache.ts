/**
 * Tool List Cache
 *
 * Provides a cross-pod cache for MCP tool lists.
 * - InMemoryToolListCache: local Map, no cross-pod sharing (dev/single-pod)
 * - JetStreamKVToolListCache: NATS JetStream KV bucket, shared across all pods
 *
 * Used by the withToolCaching decorator's fallback path (VIRTUAL connections
 * and non-VIRTUAL connections before tool indexing completes).
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  JSONCodec,
  StorageType,
  type JetStreamClient,
  type KV,
  type NatsConnection,
} from "nats";

export interface ToolListCache {
  get(connectionId: string): Promise<Tool[] | null>;
  set(connectionId: string, tools: Tool[]): Promise<void>;
  invalidate(connectionId: string): Promise<void>;
  teardown(): void;
}

export class InMemoryToolListCache implements ToolListCache {
  private readonly cache = new Map<string, Tool[]>();

  async get(connectionId: string): Promise<Tool[] | null> {
    return this.cache.get(connectionId) ?? null;
  }

  async set(connectionId: string, tools: Tool[]): Promise<void> {
    this.cache.set(connectionId, tools);
  }

  async invalidate(connectionId: string): Promise<void> {
    this.cache.delete(connectionId);
  }

  teardown(): void {
    this.cache.clear();
  }
}

const KV_BUCKET = "MESH_TOOL_LISTS";
const KV_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface JetStreamKVToolListCacheOptions {
  getJetStream: () => JetStreamClient | null;
  getConnection: () => NatsConnection | null;
}

export class JetStreamKVToolListCache implements ToolListCache {
  private kv: KV | null = null;
  private readonly codec = JSONCodec<Tool[]>();

  constructor(private readonly options: JetStreamKVToolListCacheOptions) {}

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
        "[ToolListCache] JetStream KV ready (memory storage, 5min TTL)",
      );
    } catch (err) {
      console.warn(
        "[ToolListCache] JetStream KV init failed, cache disabled:",
        err,
      );
    }
  }

  async get(connectionId: string): Promise<Tool[] | null> {
    if (!this.kv) return null;
    try {
      const entry = await this.kv.get(`tools.${connectionId}`);
      if (!entry?.value?.length) return null;
      // DEL/PURGE entries have no meaningful value
      if (entry.operation === "DEL" || entry.operation === "PURGE") return null;
      return this.codec.decode(entry.value);
    } catch {
      return null;
    }
  }

  async set(connectionId: string, tools: Tool[]): Promise<void> {
    if (!this.kv) return;
    try {
      await this.kv.put(`tools.${connectionId}`, this.codec.encode(tools));
    } catch {
      // best-effort, non-critical
    }
  }

  async invalidate(connectionId: string): Promise<void> {
    if (!this.kv) return;
    try {
      await this.kv.delete(`tools.${connectionId}`);
    } catch {
      // best-effort, non-critical
    }
  }

  teardown(): void {
    this.kv = null;
    console.log("[ToolListCache] JetStream KV torn down");
  }
}

// Module-level active cache — set once at app startup, read by withToolCaching
let activeCache: ToolListCache | null = null;

export function setToolListCache(cache: ToolListCache | null): void {
  activeCache = cache;
}

export function getToolListCache(): ToolListCache | null {
  return activeCache;
}
