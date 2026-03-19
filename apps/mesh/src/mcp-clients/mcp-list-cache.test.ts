/**
 * McpListCache unit tests
 *
 * Uses a minimal TestMcpListCache (Map-based) as a test double for
 * withMcpCaching decorator tests.
 * JetStreamKVMcpListCache requires a live NATS server — see
 * scripts/sim-tool-list-cache.ts for a multi-pod integration simulation.
 */

import { describe, expect, it } from "bun:test";
import type {
  Prompt,
  Resource,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpListCache, McpListType } from "./mcp-list-cache";
import { withMcpCaching } from "./decorators/with-mcp-caching";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ConnectionEntity } from "@/tools/connection/schema";

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
// withMcpCaching + TestMcpListCache integration (tools)
// ============================================================================

describe("withMcpCaching with TestMcpListCache", () => {
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

    const cache = new TestMcpListCache();
    const cached = withMcpCaching(client, connection, cache);

    const result = await cached.listTools();
    expect(callCount).toBe(1);
    expect(result.tools[0]!.name).toBe("fetched_tool");

    // Cache should now be populated
    const inCache = await cache.get("tools", connection.id);
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

    const cache = new TestMcpListCache();
    const cached = withMcpCaching(client, connection, cache);

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

    const cache = new TestMcpListCache();
    const cached = withMcpCaching(client, connection, cache);

    await cached.listTools();
    await cached.listTools();

    expect(callCount).toBe(2);

    // Confirm nothing was written to the cache
    expect(await cache.get("tools", connection.id)).toBeNull();
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

    const cached = withMcpCaching(client, connection); // no cache
    await cached.listTools();
    await cached.listTools();
    expect(callCount).toBe(2);
  });
});

// ============================================================================
// withMcpCaching: resources
// ============================================================================

describe("withMcpCaching resources", () => {
  it("cache miss: calls originalListResources and populates cache", async () => {
    let callCount = 0;
    const downstreamResources = [makeResource("res1")];
    const connection = makeConnection();
    const client = {
      listResources: async () => {
        callCount++;
        return { resources: downstreamResources };
      },
    } as any as Client;

    const cache = new TestMcpListCache();
    const cached = withMcpCaching(client, connection, cache);

    const result = await cached.listResources();
    expect(callCount).toBe(1);
    expect(result.resources[0]!.name).toBe("res1");
    expect(await cache.get("resources", connection.id)).toEqual(
      downstreamResources,
    );
  });

  it("cache hit: skips downstream on second call", async () => {
    let callCount = 0;
    const connection = makeConnection();
    const client = {
      listResources: async () => {
        callCount++;
        return { resources: [makeResource("res1")] };
      },
    } as any as Client;

    const cache = new TestMcpListCache();
    const cached = withMcpCaching(client, connection, cache);

    await cached.listResources();
    await cached.listResources();
    expect(callCount).toBe(1);
  });

  it("VIRTUAL connection bypasses cache", async () => {
    let callCount = 0;
    const connection = makeConnection({ connection_type: "VIRTUAL" });
    const client = {
      listResources: async () => {
        callCount++;
        return { resources: [makeResource("res1")] };
      },
    } as any as Client;

    const cache = new TestMcpListCache();
    const cached = withMcpCaching(client, connection, cache);

    await cached.listResources();
    await cached.listResources();
    expect(callCount).toBe(2);
    expect(await cache.get("resources", connection.id)).toBeNull();
  });
});

// ============================================================================
// withMcpCaching: prompts
// ============================================================================

describe("withMcpCaching prompts", () => {
  it("cache miss: calls originalListPrompts and populates cache", async () => {
    let callCount = 0;
    const downstreamPrompts = [makePrompt("prompt1")];
    const connection = makeConnection();
    const client = {
      listPrompts: async () => {
        callCount++;
        return { prompts: downstreamPrompts };
      },
    } as any as Client;

    const cache = new TestMcpListCache();
    const cached = withMcpCaching(client, connection, cache);

    const result = await cached.listPrompts();
    expect(callCount).toBe(1);
    expect(result.prompts[0]!.name).toBe("prompt1");
    expect(await cache.get("prompts", connection.id)).toEqual(
      downstreamPrompts,
    );
  });

  it("cache hit: skips downstream on second call", async () => {
    let callCount = 0;
    const connection = makeConnection();
    const client = {
      listPrompts: async () => {
        callCount++;
        return { prompts: [makePrompt("prompt1")] };
      },
    } as any as Client;

    const cache = new TestMcpListCache();
    const cached = withMcpCaching(client, connection, cache);

    await cached.listPrompts();
    await cached.listPrompts();
    expect(callCount).toBe(1);
  });

  it("VIRTUAL connection bypasses cache", async () => {
    let callCount = 0;
    const connection = makeConnection({ connection_type: "VIRTUAL" });
    const client = {
      listPrompts: async () => {
        callCount++;
        return { prompts: [makePrompt("prompt1")] };
      },
    } as any as Client;

    const cache = new TestMcpListCache();
    const cached = withMcpCaching(client, connection, cache);

    await cached.listPrompts();
    await cached.listPrompts();
    expect(callCount).toBe(2);
    expect(await cache.get("prompts", connection.id)).toBeNull();
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
    const pod1 = withMcpCaching(pod1Client, connection, sharedCache);
    await pod1.listTools();
    expect(pod1Calls).toBe(1);

    // Pod 2 — hits the shared cache, no downstream call needed
    const pod2 = withMcpCaching(pod2Client, connection, sharedCache);
    const result = await pod2.listTools();
    expect(pod2Calls).toBe(0);
    expect(result.tools).toHaveLength(2);
  });

  it("cross-pod works for resources too", async () => {
    const sharedCache = new TestMcpListCache();
    const connection = makeConnection();

    let pod1Calls = 0;
    let pod2Calls = 0;

    const pod1Client = {
      listResources: async () => {
        pod1Calls++;
        return { resources: [makeResource("r1")] };
      },
    } as any as Client;

    const pod2Client = {
      listResources: async () => {
        pod2Calls++;
        return { resources: [makeResource("r1")] };
      },
    } as any as Client;

    const pod1 = withMcpCaching(pod1Client, connection, sharedCache);
    await pod1.listResources();
    expect(pod1Calls).toBe(1);

    const pod2 = withMcpCaching(pod2Client, connection, sharedCache);
    const result = await pod2.listResources();
    expect(pod2Calls).toBe(0);
    expect(result.resources).toHaveLength(1);
  });
});
