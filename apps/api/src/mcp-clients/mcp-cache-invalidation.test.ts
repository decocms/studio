import { describe, expect, it } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  fetchWithCache,
  type McpListCache,
  type McpListType,
} from "./mcp-list-cache";
import { invalidateConnectionCaches } from "./mcp-cache-invalidation";

const makeTool = (name: string): Tool => ({
  name,
  description: `Tool ${name}`,
  inputSchema: { type: "object", properties: {} },
});

/** Minimal Map-based McpListCache for testing. */
class TestMcpListCache implements McpListCache {
  private readonly cache = new Map<string, unknown[]>();
  async get(type: McpListType, connectionId: string) {
    return this.cache.get(`${type}.${connectionId}`) ?? null;
  }
  async set(type: McpListType, connectionId: string, data: unknown[]) {
    this.cache.set(`${type}.${connectionId}`, data);
  }
  async invalidate(connectionId: string) {
    for (const type of ["tools", "resources", "prompts"] as McpListType[]) {
      this.cache.delete(`${type}.${connectionId}`);
    }
  }
  teardown() {}
}

describe("invalidateConnectionCaches", () => {
  it("also lifts the list-revalidation throttle, not just the read cache", async () => {
    const conn = "conn_invalidated_via_cache_bus";
    const cache = new TestMcpListCache();
    await cache.set("tools", conn, [makeTool("stale")]);

    let callCount = 0;
    const fetchLive = async () => {
      callCount++;
      return [makeTool("fresh")];
    };

    await fetchWithCache("tools", conn, fetchLive, cache, undefined, 10_000);
    await new Promise((r) => setTimeout(r, 5));
    expect(callCount).toBe(1);

    // No NATS connection registered here — exercises the local-eviction path.
    invalidateConnectionCaches(conn);

    await fetchWithCache("tools", conn, fetchLive, cache, undefined, 10_000);
    await new Promise((r) => setTimeout(r, 5));
    expect(callCount).toBe(2);
  });
});
