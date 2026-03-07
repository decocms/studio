/**
 * ToolListCache unit tests
 *
 * Tests InMemoryToolListCache directly.
 * JetStreamKVToolListCache requires a live NATS server — see
 * scripts/sim-tool-list-cache.ts for a multi-pod integration simulation.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryToolListCache } from "./tool-list-cache";
import { withToolCaching } from "./decorators/with-tool-caching";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ConnectionEntity } from "@/tools/connection/schema";

const makeTool = (name: string): Tool => ({
  name,
  description: `Tool ${name}`,
  inputSchema: { type: "object", properties: {} },
});

const makeConnection = (
  overrides: Partial<ConnectionEntity> = {},
): ConnectionEntity =>
  ({
    id: "conn_test_123",
    title: "Test Connection",
    organization_id: "org_test",
    connection_type: "HTTP",
    status: "active",
    tools: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "user_test",
    description: null,
    icon: null,
    app_name: null,
    app_id: null,
    connection_url: "https://example.com/mcp",
    connection_parameters: null,
    configuration_state: null,
    updated_by: null,
    ...overrides,
  }) as ConnectionEntity;

// ============================================================================
// InMemoryToolListCache
// ============================================================================

describe("InMemoryToolListCache", () => {
  let cache: InMemoryToolListCache;

  beforeEach(() => {
    cache = new InMemoryToolListCache();
  });

  it("returns null for unknown connection", async () => {
    expect(await cache.get("missing")).toBeNull();
  });

  it("stores and retrieves tools", async () => {
    const tools = [makeTool("tool_a"), makeTool("tool_b")];
    await cache.set("conn_1", tools);
    expect(await cache.get("conn_1")).toEqual(tools);
  });

  it("invalidates a connection", async () => {
    await cache.set("conn_1", [makeTool("tool_a")]);
    await cache.invalidate("conn_1");
    expect(await cache.get("conn_1")).toBeNull();
  });

  it("teardown clears all entries", async () => {
    await cache.set("conn_1", [makeTool("tool_a")]);
    await cache.set("conn_2", [makeTool("tool_b")]);
    cache.teardown();
    expect(await cache.get("conn_1")).toBeNull();
    expect(await cache.get("conn_2")).toBeNull();
  });

  it("isolates separate connection IDs", async () => {
    const tools1 = [makeTool("tool_1")];
    const tools2 = [makeTool("tool_2")];
    await cache.set("conn_1", tools1);
    await cache.set("conn_2", tools2);
    expect(await cache.get("conn_1")).toEqual(tools1);
    expect(await cache.get("conn_2")).toEqual(tools2);
  });
});

// ============================================================================
// withToolCaching + InMemoryToolListCache integration
// ============================================================================

describe("withToolCaching with InMemoryToolListCache", () => {
  it("returns DB tools for non-VIRTUAL connection with indexed tools (cache not used)", async () => {
    const dbTools = [makeTool("db_tool")];
    const connection = makeConnection({ tools: dbTools as any });
    const client = {
      listTools: async () => ({ tools: [makeTool("downstream")] }),
    } as any as Client;

    const cached = withToolCaching(
      client,
      connection,
      new InMemoryToolListCache(),
    );
    const result = await cached.listTools();
    expect(result.tools[0]!.name).toBe("db_tool");
  });

  it("cache miss: calls originalListTools and populates cache", async () => {
    let callCount = 0;
    const downstreamTools = [makeTool("fetched_tool")];
    const connection = makeConnection({ tools: null });
    const client = {
      listTools: async () => {
        callCount++;
        return { tools: downstreamTools };
      },
    } as any as Client;

    const cache = new InMemoryToolListCache();
    const cached = withToolCaching(client, connection, cache);

    const result = await cached.listTools();
    expect(callCount).toBe(1);
    expect(result.tools[0]!.name).toBe("fetched_tool");

    // Cache should now be populated
    const inCache = await cache.get(connection.id);
    expect(inCache).toEqual(downstreamTools);
  });

  it("cache hit: skips originalListTools on second call", async () => {
    let callCount = 0;
    const connection = makeConnection({ tools: null });
    const client = {
      listTools: async () => {
        callCount++;
        return { tools: [makeTool("fetched_tool")] };
      },
    } as any as Client;

    const cache = new InMemoryToolListCache();
    const cached = withToolCaching(client, connection, cache);

    await cached.listTools(); // miss — populates cache
    await cached.listTools(); // hit — no downstream call

    expect(callCount).toBe(1);
  });

  it("VIRTUAL connection always calls originalListTools (bypasses cache)", async () => {
    let callCount = 0;
    const connection = makeConnection({
      connection_type: "VIRTUAL",
      tools: null,
    });
    const client = {
      listTools: async () => {
        callCount++;
        return { tools: [makeTool("virtual_tool")] };
      },
    } as any as Client;

    const cache = new InMemoryToolListCache();
    const cached = withToolCaching(client, connection, cache);

    await cached.listTools();
    await cached.listTools();

    // VIRTUAL connections bypass both the DB check and the cross-pod cache,
    // so originalListTools() must be called on every invocation
    expect(callCount).toBe(2);

    // Confirm nothing was written to the cache
    expect(await cache.get(connection.id)).toBeNull();
  });

  it("no cache argument: falls back to downstream every time", async () => {
    let callCount = 0;
    const connection = makeConnection({ tools: null });
    const client = {
      listTools: async () => {
        callCount++;
        return { tools: [makeTool("tool")] };
      },
    } as any as Client;

    const cached = withToolCaching(client, connection); // no cache
    await cached.listTools();
    await cached.listTools();
    expect(callCount).toBe(2);
  });
});

// ============================================================================
// Cross-pod simulation using shared InMemoryToolListCache instance
// ============================================================================

describe("cross-pod cache simulation (shared InMemoryToolListCache)", () => {
  it("pod-2 gets cached result populated by pod-1", async () => {
    const sharedCache = new InMemoryToolListCache();
    const connection = makeConnection({ tools: null });

    let pod1Calls = 0;
    let pod2Calls = 0;

    const pod1Client = {
      listTools: async () => {
        pod1Calls++;
        return { tools: [makeTool("tool_a"), makeTool("tool_b")] };
      },
    } as any as Client;

    const pod2Client = {
      listTools: async () => {
        pod2Calls++;
        return { tools: [makeTool("tool_a"), makeTool("tool_b")] };
      },
    } as any as Client;

    // Pod 1 cold start — fetches from downstream and populates cache
    const pod1 = withToolCaching(pod1Client, connection, sharedCache);
    await pod1.listTools();
    expect(pod1Calls).toBe(1);

    // Pod 2 — hits the shared cache, no downstream call needed
    const pod2 = withToolCaching(pod2Client, connection, sharedCache);
    const result = await pod2.listTools();
    expect(pod2Calls).toBe(0);
    expect(result.tools).toHaveLength(2);
  });
});
