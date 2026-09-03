/**
 * McpListCache unit tests
 *
 * Uses a minimal TestMcpListCache (Map-based) as a test double for
 * fetchWithCache tests.
 * JetStreamKVMcpListCache requires a live NATS server — see
 * scripts/sim-tool-list-cache.ts for a multi-pod integration simulation.
 */

import { describe, expect, it } from "bun:test";
import type {
  Prompt,
  Resource,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  clearRevalidationState,
  fetchWithCache,
  isRevalidationStale,
  type McpListCache,
  type McpListType,
} from "./mcp-list-cache";

const makeTool = (name: string): Tool => ({
  name,
  description: `Tool ${name}`,
  inputSchema: { type: "object", properties: {} },
});

const makeResource = (name: string, uri?: string): Resource => ({
  name,
  uri: uri ?? `resource://${name}`,
});

const makePrompt = (name: string): Prompt => ({
  name,
  description: `Prompt ${name}`,
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
  teardown() {
    this.cache.clear();
  }
}

// ============================================================================
// fetchWithCache direct tests
// ============================================================================

describe("fetchWithCache", () => {
  it("cache miss: calls fetchLive and populates cache", async () => {
    const cache = new TestMcpListCache();
    const tools = [makeTool("t1")];
    const data = await fetchWithCache(
      "tools",
      "conn1",
      async () => tools,
      cache,
    );
    expect(data).toEqual(tools);
    // Wait for fire-and-forget cache.set
    await new Promise((r) => setTimeout(r, 10));
    expect(await cache.get("tools", "conn1")).toEqual(tools);
  });

  it("cache hit: returns cached data and revalidates in background", async () => {
    const cache = new TestMcpListCache();
    const stale = [makeTool("stale")];
    const fresh = [makeTool("fresh")];
    await cache.set("tools", "conn1", stale);

    let callCount = 0;
    const data = await fetchWithCache(
      "tools",
      "conn1",
      async () => {
        callCount++;
        return fresh;
      },
      cache,
    );

    // Returns stale data immediately
    expect(data).toEqual(stale);
    // Upstream was started (background revalidation)
    expect(callCount).toBe(1);
    // Wait for background update
    await new Promise((r) => setTimeout(r, 10));
    expect(await cache.get("tools", "conn1")).toEqual(fresh);
  });

  it("no cache: calls fetchLive directly", async () => {
    const tools = [makeTool("t1")];
    const data = await fetchWithCache(
      "tools",
      "conn1",
      async () => tools,
      null,
    );
    expect(data).toEqual(tools);
  });

  it("no cache + upstream failure: returns null", async () => {
    const data = await fetchWithCache(
      "tools",
      "conn1",
      async () => {
        throw new Error("fail");
      },
      null,
    );
    expect(data).toBeNull();
  });

  it("cache miss + upstream failure: returns null", async () => {
    const cache = new TestMcpListCache();
    const data = await fetchWithCache(
      "tools",
      "conn1",
      async () => {
        throw new Error("fail");
      },
      cache,
    );
    expect(data).toBeNull();
  });

  it("cache hit + upstream failure: returns cached data", async () => {
    const cache = new TestMcpListCache();
    const stale = [makeTool("stale")];
    await cache.set("tools", "conn1", stale);

    const data = await fetchWithCache(
      "tools",
      "conn1",
      async () => {
        throw new Error("fail");
      },
      cache,
    );

    expect(data).toEqual(stale);
    // Wait for background to settle
    await new Promise((r) => setTimeout(r, 10));
    // Cache still has stale data (upstream failed)
    expect(await cache.get("tools", "conn1")).toEqual(stale);
  });

  it("deduplicates concurrent revalidations for same key", async () => {
    const cache = new TestMcpListCache();
    const stale = [makeTool("stale")];
    await cache.set("tools", "conn1", stale);

    let callCount = 0;
    const fetchLive = async () => {
      callCount++;
      // Simulate slow upstream
      await new Promise((r) => setTimeout(r, 50));
      return [makeTool("fresh")];
    };

    // Fire two concurrent calls
    const [r1, r2] = await Promise.all([
      fetchWithCache("tools", "conn1", fetchLive, cache),
      fetchWithCache("tools", "conn1", fetchLive, cache),
    ]);

    expect(r1).toEqual(stale);
    expect(r2).toEqual(stale);
    // Only one revalidation should be started (the second is skipped
    // because the first is already in-flight)
    expect(callCount).toBe(1);
    // Wait for background
    await new Promise((r) => setTimeout(r, 60));
    expect(await cache.get("tools", "conn1")).toEqual([makeTool("fresh")]);
  });

  it("calls onRevalidation callback with revalidation promise on cache hit", async () => {
    const cache = new TestMcpListCache();
    const stale = [makeTool("stale")];
    const fresh = [makeTool("fresh")];
    await cache.set("tools", "conn1", stale);

    const revalidations: Promise<void>[] = [];
    const onRevalidation = (p: Promise<void>) => revalidations.push(p);

    const data = await fetchWithCache(
      "tools",
      "conn1",
      async () => fresh,
      cache,
      onRevalidation,
    );

    expect(data).toEqual(stale);
    expect(revalidations).toHaveLength(1);

    // Await the revalidation promise — cache should be updated
    await Promise.allSettled(revalidations);
    expect(await cache.get("tools", "conn1")).toEqual(fresh);
  });

  it("does not call onRevalidation on cache miss", async () => {
    const cache = new TestMcpListCache();
    const tools = [makeTool("t1")];

    const revalidations: Promise<void>[] = [];
    const onRevalidation = (p: Promise<void>) => revalidations.push(p);

    await fetchWithCache(
      "tools",
      "conn1",
      async () => tools,
      cache,
      onRevalidation,
    );

    expect(revalidations).toHaveLength(0);
  });

  it("throttles background revalidation within the min interval", async () => {
    // Unique connection id so the module-level throttle map isn't shared with
    // other tests in this file.
    const conn = "conn_throttle_within";
    const cache = new TestMcpListCache();
    await cache.set("tools", conn, [makeTool("stale")]);

    let callCount = 0;
    const fetchLive = async () => {
      callCount++;
      return [makeTool("fresh")];
    };

    // First hit: nothing revalidated yet → revalidates and starts the clock.
    await fetchWithCache("tools", conn, fetchLive, cache, undefined, 10_000);
    await new Promise((r) => setTimeout(r, 5));
    expect(callCount).toBe(1);

    // Second hit immediately after: within the 10s window → throttled, no fetch.
    await fetchWithCache("tools", conn, fetchLive, cache, undefined, 10_000);
    await new Promise((r) => setTimeout(r, 5));
    expect(callCount).toBe(1);
  });

  it("revalidates again once the min interval has elapsed", async () => {
    const conn = "conn_throttle_elapsed";
    const cache = new TestMcpListCache();
    await cache.set("tools", conn, [makeTool("stale")]);

    let callCount = 0;
    const fetchLive = async () => {
      callCount++;
      return [makeTool("fresh")];
    };

    // Tiny interval so the window lapses between calls.
    await fetchWithCache("tools", conn, fetchLive, cache, undefined, 20);
    await new Promise((r) => setTimeout(r, 5));
    expect(callCount).toBe(1);

    await new Promise((r) => setTimeout(r, 30)); // exceed the 20ms window
    await fetchWithCache("tools", conn, fetchLive, cache, undefined, 20);
    await new Promise((r) => setTimeout(r, 5));
    expect(callCount).toBe(2);
  });

  it("clearRevalidationState lifts the throttle for a deleted connection", async () => {
    const conn = "conn_cleared_on_delete";
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

    clearRevalidationState(conn);

    // Not throttled: the pre-delete clock is gone, not just stale.
    await fetchWithCache("tools", conn, fetchLive, cache, undefined, 10_000);
    await new Promise((r) => setTimeout(r, 5));
    expect(callCount).toBe(2);
  });

  it("a cache miss starts the throttle clock (immediate hit is throttled)", async () => {
    const conn = "conn_throttle_miss";
    const cache = new TestMcpListCache();

    let callCount = 0;
    const fetchLive = async () => {
      callCount++;
      return [makeTool("t")];
    };

    // Miss → live fetch (counts) and seeds the throttle timestamp.
    await fetchWithCache("tools", conn, fetchLive, cache, undefined, 10_000);
    await new Promise((r) => setTimeout(r, 5));
    expect(callCount).toBe(1);

    // Immediate hit → throttled, no background revalidation.
    await fetchWithCache("tools", conn, fetchLive, cache, undefined, 10_000);
    await new Promise((r) => setTimeout(r, 5));
    expect(callCount).toBe(1);
  });

  it("interval <= 0 disables throttling (revalidates every hit)", async () => {
    const conn = "conn_throttle_off";
    const cache = new TestMcpListCache();
    await cache.set("tools", conn, [makeTool("stale")]);

    let callCount = 0;
    const fetchLive = async () => {
      callCount++;
      return [makeTool("fresh")];
    };

    await fetchWithCache("tools", conn, fetchLive, cache, undefined, 0);
    await new Promise((r) => setTimeout(r, 5));
    await fetchWithCache("tools", conn, fetchLive, cache, undefined, 0);
    await new Promise((r) => setTimeout(r, 5));
    expect(callCount).toBe(2);
  });

  it("silently handles connection closed errors during revalidation", async () => {
    const cache = new TestMcpListCache();
    const stale = [makeTool("stale")];
    await cache.set("tools", "conn1", stale);

    const { McpError } = await import("@modelcontextprotocol/sdk/types.js");
    const revalidations: Promise<void>[] = [];

    const data = await fetchWithCache(
      "tools",
      "conn1",
      async () => {
        throw new McpError(-32000, "Connection closed");
      },
      cache,
      (p) => revalidations.push(p),
    );

    expect(data).toEqual(stale);
    await Promise.allSettled(revalidations);
    // Cache should still have stale data (revalidation failed silently)
    expect(await cache.get("tools", "conn1")).toEqual(stale);
  });
});

// ============================================================================
// isRevalidationStale (pure throttle predicate)
// ============================================================================

describe("isRevalidationStale", () => {
  it("is always stale when interval <= 0 (throttle disabled)", () => {
    expect(isRevalidationStale(undefined, 1000, 0)).toBe(true);
    expect(isRevalidationStale(1000, 1000, 0)).toBe(true);
    expect(isRevalidationStale(1000, 1000, -5)).toBe(true);
  });

  it("is stale when never revalidated", () => {
    expect(isRevalidationStale(undefined, 1000, 30_000)).toBe(true);
  });

  it("is fresh within the interval and stale once it elapses", () => {
    expect(isRevalidationStale(1000, 1000 + 29_999, 30_000)).toBe(false);
    expect(isRevalidationStale(1000, 1000 + 30_000, 30_000)).toBe(true);
    expect(isRevalidationStale(1000, 1000 + 60_000, 30_000)).toBe(true);
  });
});

// ============================================================================
// invalidate clears all three types
// ============================================================================

describe("McpListCache invalidate", () => {
  it("clears tools, resources, and prompts for a connection", async () => {
    const cache = new TestMcpListCache();
    const connId = "conn_test_123";

    await cache.set("tools", connId, [makeTool("t1")]);
    await cache.set("resources", connId, [makeResource("r1")]);
    await cache.set("prompts", connId, [makePrompt("p1")]);

    expect(await cache.get("tools", connId)).not.toBeNull();
    expect(await cache.get("resources", connId)).not.toBeNull();
    expect(await cache.get("prompts", connId)).not.toBeNull();

    await cache.invalidate(connId);

    expect(await cache.get("tools", connId)).toBeNull();
    expect(await cache.get("resources", connId)).toBeNull();
    expect(await cache.get("prompts", connId)).toBeNull();
  });
});

// ============================================================================
// Cross-pod simulation using shared TestMcpListCache instance
// ============================================================================

describe("cross-pod cache simulation (shared TestMcpListCache)", () => {
  it("pod-2 gets cached result populated by pod-1", async () => {
    const sharedCache = new TestMcpListCache();
    const connId = "conn_cross_pod";

    let pod1Calls = 0;
    let pod2Calls = 0;

    // Pod 1 cold start — fetches from downstream and populates cache
    await fetchWithCache(
      "tools",
      connId,
      async () => {
        pod1Calls++;
        return [makeTool("tool_a"), makeTool("tool_b")];
      },
      sharedCache,
    );
    expect(pod1Calls).toBe(1);
    await new Promise((r) => setTimeout(r, 10));

    // Pod 2 — hits the shared cache, returns stale data + background reval
    const result = await fetchWithCache(
      "tools",
      connId,
      async () => {
        pod2Calls++;
        return [makeTool("tool_a"), makeTool("tool_b")];
      },
      sharedCache,
    );
    // SWR: pod2 gets cached data immediately but also starts background revalidation
    expect(result).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 10));
    expect(pod2Calls).toBe(1); // background reval
  });

  it("cross-pod works for resources too", async () => {
    const sharedCache = new TestMcpListCache();
    const connId = "conn_cross_pod_resources";

    let pod1Calls = 0;
    let pod2Calls = 0;

    await fetchWithCache(
      "resources",
      connId,
      async () => {
        pod1Calls++;
        return [makeResource("r1")];
      },
      sharedCache,
    );
    expect(pod1Calls).toBe(1);
    await new Promise((r) => setTimeout(r, 10));

    const result = await fetchWithCache(
      "resources",
      connId,
      async () => {
        pod2Calls++;
        return [makeResource("r1")];
      },
      sharedCache,
    );
    expect(result).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(pod2Calls).toBe(1); // background reval
  });
});
