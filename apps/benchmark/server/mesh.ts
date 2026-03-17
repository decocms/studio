/**
 * Mesh Server Setup for Benchmarking
 *
 * Programmatically starts the mesh server with a temp file database
 * and uses MCP APIs to create connections and gateways.
 */

import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  MeshServerHandle,
  VirtualMCPtoolSelectionStrategy,
} from "../types";

// Import from sibling mesh package (internal imports)
import { createApp } from "decocms/src/api/app";
import { createDatabase, closeDatabase } from "decocms/src/database";
import type { EventBus } from "decocms/src/event-bus";
import { migrateToLatest } from "decocms/src/database/migrate";
import type { BenchmarkSeedResult } from "decocms/migrations/seeds";
import { auth } from "decocms/src/auth";
import type { Permission } from "decocms/src/storage/types";

/**
 * Create a no-op mock event bus for benchmark testing
 */
function createMockEventBus(): EventBus {
  return {
    start: async () => {},
    stop: () => {},
    isRunning: () => false,
    publish: async () => ({}) as never,
    subscribe: async () => ({}) as never,
    unsubscribe: async () => ({ success: true }),
    listSubscriptions: async () => [],
    getSubscription: async () => null,
    getEvent: async () => null,
    cancelEvent: async () => ({ success: true }),
    ackEvent: async () => ({ success: true }),
    syncSubscriptions: async () => ({
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      subscriptions: [],
    }),
  };
}

/**
 * Generate a unique ID with prefix
 */
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

interface BetterAuthApiKeyResult {
  valid: boolean;
  error: null | { message: string };
  key?: {
    id: string;
    name: string;
    userId: string;
    permissions: Permission;
    metadata?: Record<string, unknown>;
  };
}

/**
 * Parse SSE response as JSON (copied from mesh tools/client.ts)
 */
async function parseSSEResponseAsJson(response: Response) {
  const raw = await response.text();
  const data = raw.split("\n").find((line) => line.startsWith("data: "));

  if (!data) {
    throw new Error("No data received from the server");
  }

  const json = JSON.parse(data.replace("data: ", ""));
  return json;
}

/**
 * Start a mesh server for benchmarking
 */
export async function startMesh(port: number): Promise<MeshServerHandle> {
  // Use a temp file because PGlite needs a persistent data directory
  const dbPath = join(
    tmpdir(),
    `mesh-benchmark-${Date.now()}-${Math.random().toString(36).slice(2)}.pglite`,
  );
  const database = createDatabase(dbPath);

  // Run Kysely migrations and benchmark seed
  // Skip Better Auth migrations because the auth singleton is already configured
  // with a different database. The benchmark seed creates the tables it needs.
  const { seedResult } = await migrateToLatest<BenchmarkSeedResult>({
    database,
    skipBetterAuth: true,
    keepOpen: true,
    seed: "benchmark",
  });

  if (!seedResult) {
    throw new Error("Benchmark seed failed to return result");
  }

  const { organizationId: orgId, userId } = seedResult;

  // Create organization data for API key metadata
  const organization = {
    id: orgId,
    slug: "benchmark-org",
    name: "Benchmark Organization",
  };

  // Create API key for authentication
  const apiKey = `benchmark_key_${generateId("key")}`;

  // Monkey-patch Better Auth methods for benchmarking
  // Store originals in closure scope for safe restoration (prevents race conditions)
  const authApi = auth.api as Record<string, unknown>;
  const originalGetMcpSession = authApi.getMcpSession;
  const originalSetActiveOrganization = authApi.setActiveOrganization;
  const originalVerifyApiKey = authApi.verifyApiKey;

  // Mock getMcpSession
  authApi.getMcpSession = async () => null;

  // Mock setActiveOrganization
  authApi.setActiveOrganization = async () => null;

  // Mock verifyApiKey
  authApi.verifyApiKey = async (params: { body: { key: string } }) => {
    if (params.body.key === apiKey) {
      return {
        valid: true,
        error: null,
        key: {
          id: "benchmark-api-key",
          name: "Benchmark API Key",
          userId: userId,
          // Grant all permissions on "self" resource for management tools
          permissions: {
            self: ["*"],
          },
          metadata: { organization },
        },
      } as BetterAuthApiKeyResult;
    }
    return {
      valid: false,
      error: { message: "Invalid API key" },
    } as BetterAuthApiKeyResult;
  };

  // Create mock event bus
  const eventBus = createMockEventBus();

  // Create the app
  const app = createApp({ database, eventBus });

  // Start the server
  const server = Bun.serve({
    port,
    fetch: app.fetch,
  });

  const actualPort = server.port;
  const baseUrl = `http://localhost:${actualPort}`;

  /**
   * Call an MCP tool using the same pattern as createToolCaller
   */
  async function callMcpTool<TOutput = unknown>(
    toolName: string,
    args: unknown,
  ): Promise<TOutput> {
    const response = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP error! status: ${response.status} - ${text}`);
    }

    const contentType = response.headers.get("Content-Type");
    const json = contentType?.includes("application/json")
      ? await response.json()
      : await parseSSEResponseAsJson(response);

    if (json.result?.isError) {
      throw new Error(json.result.content?.[0]?.text || "Tool call failed");
    }

    return json.result?.structuredContent || json.result;
  }

  return {
    baseUrl,
    apiKey,

    createConnection: async (mcpUrl: string): Promise<string> => {
      const result = await callMcpTool<{ item: { id: string } }>(
        "CONNECTIONS_CREATE",
        {
          data: {
            title: "Benchmark MCP",
            description: "Fake MCP server for benchmarking",
            connection_type: "HTTP",
            connection_url: mcpUrl,
          },
        },
      );

      if (!result?.item?.id) {
        console.error("Unexpected result:", JSON.stringify(result, null, 2));
        throw new Error("No connection ID returned");
      }

      return result.item.id;
    },

    createGateway: async (
      connectionId: string,
      strategy: VirtualMCPtoolSelectionStrategy,
    ): Promise<string> => {
      const result = await callMcpTool<{ item: { id: string } }>(
        "VIRTUAL_MCP_CREATE",
        {
          data: {
            title: `Benchmark Agent (${strategy})`,
            description: `Agent using ${strategy} strategy`,
            tool_selection_mode: "inclusion",
            connections: [
              {
                connection_id: connectionId,
                selected_tools: null, // All tools
              },
            ],
          },
        },
      );

      if (!result?.item?.id) {
        console.error("Unexpected result:", JSON.stringify(result, null, 2));
        throw new Error("No agent ID returned");
      }

      return result.item.id;
    },

    getGatewayUrl: (
      gatewayId: string,
      strategy?: VirtualMCPtoolSelectionStrategy,
    ): string => {
      const url = new URL(`/mcp/gateway/${gatewayId}`, baseUrl);
      if (strategy) {
        url.searchParams.set("mode", strategy);
      }
      return url.href;
    },

    cleanup: async (): Promise<void> => {
      server.stop(true);
      await closeDatabase(database);

      // Delete temp database directory (PGlite creates a directory, not a file)
      try {
        rmSync(dbPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }

      // Restore original auth methods (using closure-scoped originals)
      authApi.getMcpSession = originalGetMcpSession;
      authApi.setActiveOrganization = originalSetActiveOrganization;
      authApi.verifyApiKey = originalVerifyApiKey;
    },
  };
}
