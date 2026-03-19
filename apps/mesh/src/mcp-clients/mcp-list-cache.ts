/**
 * MCP List Cache
 *
 * Provides a cross-pod cache for MCP tool, resource, and prompt lists via NATS JetStream KV.
 *
 * Used by the withMcpCaching decorator and lazy clients in PassthroughClient.
 */

import { JSONCodec, StorageType, type JetStreamClient, type KV } from "nats";

export type McpListType = "tools" | "resources" | "prompts";

export interface McpListCache {
  get(type: McpListType, connectionId: string): Promise<unknown[] | null>;
  set(type: McpListType, connectionId: string, data: unknown[]): Promise<void>;
  invalidate(connectionId: string): Promise<void>;
  teardown(): void;
}

const KV_BUCKET = "DECOCMS_MCP_LISTS";
const KV_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface JetStreamKVMcpListCacheOptions {
  getJetStream: () => JetStreamClient;
}

export class JetStreamKVMcpListCache implements McpListCache {
  private kv: KV | null = null;
  private readonly codec = JSONCodec<unknown[]>();

  constructor(private readonly options: JetStreamKVMcpListCacheOptions) {}

  async init(): Promise<void> {
    const js = this.options.getJetStream();
    this.kv = await js.views.kv(KV_BUCKET, {
      ttl: KV_TTL_MS,
      storage: StorageType.Memory,
    });
  }

  async get(
    type: McpListType,
    connectionId: string,
  ): Promise<unknown[] | null> {
    if (!this.kv) return null;
    try {
      const entry = await this.kv.get(`${type}.${connectionId}`);
      if (!entry?.value?.length) return null;
      // DEL/PURGE entries have no meaningful value
      if (entry.operation === "DEL" || entry.operation === "PURGE") return null;
      return this.codec.decode(entry.value);
    } catch {
      return null;
    }
  }

  async set(
    type: McpListType,
    connectionId: string,
    data: unknown[],
  ): Promise<void> {
    if (!this.kv) return;
    try {
      await this.kv.put(`${type}.${connectionId}`, this.codec.encode(data));
    } catch {
      // best-effort, non-critical
    }
  }

  async invalidate(connectionId: string): Promise<void> {
    if (!this.kv) return;
    const types: McpListType[] = ["tools", "resources", "prompts"];
    await Promise.all(
      types.map(async (type) => {
        try {
          await this.kv!.delete(`${type}.${connectionId}`);
        } catch {
          // best-effort, non-critical
        }
      }),
    );
  }

  teardown(): void {
    this.kv = null;
  }
}

// Module-level active cache — set once at app startup, read by withMcpCaching
let activeCache: McpListCache | null = null;

export function setMcpListCache(cache: McpListCache | null): void {
  activeCache = cache;
}

export function getMcpListCache(): McpListCache | null {
  return activeCache;
}
