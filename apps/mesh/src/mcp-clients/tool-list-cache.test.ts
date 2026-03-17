/**
 * ToolListCache unit tests
 *
 * Uses a minimal TestToolListCache (Map-based) as a test double for
 * withToolCaching decorator tests.
 * JetStreamKVToolListCache requires a live NATS server — see
 * scripts/sim-tool-list-cache.ts for a multi-pod integration simulation.
 */

import { describe, expect, it } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolListCache } from "./tool-list-cache";
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

/** Minimal Map-based ToolListCache for testing. */
class TestToolListCache implements ToolListCache {
  private readonly cache = new Map<string, Tool[]>();
  async get(connectionId: string) {
    return this.cache.get(connectionId) ?? null;
  }
  async set(connectionId: string, tools: Tool[]) {
    this.cache.set(connectionId, tools);
  }
  async invalidate(connectionId: string) {
    this.cache.delete(connectionId);
  }
  teardown() {
    this.cache.clear();
  }
}

// ============================================================================
// withToolCaching + TestToolListCache integration
// ============================================================================

describe("withToolCaching with TestToolListCache", () => {
  it("returns DB tools for non-VIRTUAL connection with indexed tools (cache not used)", async () => {
    const dbTools = [makeTool("db_tool")];
    const connection = makeConnection({ tools: dbTools as any });
    const client = {
      listTools: async () => ({ tools: [makeTool("downstream")] }),
    } as any as Client;

    const cached = withToolCaching(client, connection, new TestToolListCache());
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

    const cache = new TestToolListCache();
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

    const cache = new TestToolListCache();
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

    const cache = new TestToolListCache();
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
// Cross-pod simulation using shared TestToolListCache instance
// ============================================================================

describe("cross-pod cache simulation (shared TestToolListCache)", () => {
  it("pod-2 gets cached result populated by pod-1", async () => {
    const sharedCache = new TestToolListCache();
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
