/**
 * MCP List Cache
 *
 * Provides a cross-pod cache for MCP tool, resource, and prompt lists via NATS JetStream KV.
 *
 * Used by the withMcpCaching decorator and lazy clients in PassthroughClient.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { JSONCodec, StorageType, type JetStreamClient, type KV } from "nats";
import { meter } from "../observability";

const cacheCounter = meter.createCounter("mcp_list_cache.fetches", {
  description: "MCP list cache fetch outcomes (hit, miss, error)",
  unit: "{fetches}",
});

export type McpListType = "tools" | "resources" | "prompts";

export interface McpListCache {
  get(type: McpListType, connectionId: string): Promise<unknown[] | null>;
  set(type: McpListType, connectionId: string, data: unknown[]): Promise<void>;
  invalidate(connectionId: string): Promise<void>;
  teardown(): void;
}

const KV_BUCKET = "DECOCMS_MCP_LISTS";

export interface JetStreamKVMcpListCacheOptions {
  getJetStream: () => JetStreamClient | null;
}

export class JetStreamKVMcpListCache implements McpListCache {
  private kv: KV | null = null;
  private readonly codec = JSONCodec<unknown[]>();

  constructor(private readonly options: JetStreamKVMcpListCacheOptions) {}

  async init(): Promise<void> {
    const js = this.options.getJetStream();
    if (!js) return; // NATS not ready — cache disabled until re-init
    this.kv = await js.views.kv(KV_BUCKET, {
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

  /** Purge all cached entries — used on server startup/HMR to ensure fresh data. */
  async purgeAll(): Promise<void> {
    if (!this.kv) return;
    try {
      const keys = await this.kv.keys();
      for await (const key of keys) {
        await this.kv.delete(key).catch(() => {});
      }
    } catch {
      // best-effort
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

// Module-level revalidation tracking (prevents thundering herd)
const revalidating = new Set<string>();

function isMethodNotFound(err: unknown): boolean {
  return err instanceof McpError && err.code === ErrorCode.MethodNotFound;
}

function isConnectionClosed(err: unknown): boolean {
  return (
    err instanceof McpError &&
    err.code === -32000 &&
    /connection closed/i.test(err.message)
  );
}

/**
 * Fetch with cache: checks cache first, then revalidates in background.
 * On cache hit, returns cached data immediately and revalidates in background.
 */
export async function fetchWithCache(
  type: McpListType,
  connectionId: string,
  fetchLive: () => Promise<unknown[]>,
  cache: McpListCache | null,
  onRevalidation?: (promise: Promise<void>) => void,
): Promise<unknown[] | null> {
  if (!cache) {
    try {
      return await fetchLive();
    } catch (err) {
      if (isMethodNotFound(err)) return [];
      cacheCounter.add(1, {
        type,
        outcome: "error",
        stage: "no_cache",
      });
      return null;
    }
  }

  // Check cache first
  const cached = await cache.get(type, connectionId);

  if (cached === null) {
    // Cache miss: fetch live and populate cache
    try {
      const data = await fetchLive();
      cache.set(type, connectionId, data).catch(() => {});
      cacheCounter.add(1, { type, outcome: "miss", stage: "miss" });
      return data;
    } catch (err) {
      if (isMethodNotFound(err)) {
        cache.set(type, connectionId, []).catch(() => {});
        return [];
      }
      cacheCounter.add(1, {
        type,
        outcome: "error",
        stage: "miss",
      });
      return null;
    }
  }

  cacheCounter.add(1, { type, outcome: "hit", stage: "hit" });
  // Cache hit: return immediately, revalidate in background
  const revalKey = `${type}:${connectionId}`;
  if (!revalidating.has(revalKey)) {
    revalidating.add(revalKey);
    const revalPromise = fetchLive()
      .then((data) => cache.set(type, connectionId, data))
      .catch((err) => {
        if (isMethodNotFound(err) || isConnectionClosed(err)) {
          if (isMethodNotFound(err)) {
            cache.set(type, connectionId, []).catch(() => {});
          }
          return;
        }
        cacheCounter.add(1, {
          type,
          outcome: "error",
          stage: "revalidation",
        });
      })
      .finally(() => revalidating.delete(revalKey));

    onRevalidation?.(revalPromise);
  }

  return cached;
}

// Module-level active cache — set once at app startup, read by withMcpCaching
let activeCache: McpListCache | null = null;

export function setMcpListCache(cache: McpListCache | null): void {
  activeCache = cache;
}

export function getMcpListCache(): McpListCache | null {
  return activeCache;
}
