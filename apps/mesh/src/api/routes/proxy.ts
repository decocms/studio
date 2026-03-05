/**
 * MCP Proxy Routes
 *
 * Proxies MCP requests to downstream connections using the official MCP SDK.
 * Based on the pattern from @modelcontextprotocol/typescript-sdk
 *
 * Architecture:
 * - Creates MCP Server to handle incoming requests
 * - Creates MCP Client to connect to downstream connections
 * - Uses middleware pipeline for authorization
 * - Supports StreamableHTTP and STDIO transports
 */

import {
  clientFromConnection,
  serverFromConnection,
  withToolCaching,
  type ClientWithOptionalStreamingSupport,
  type ClientWithStreamingSupport,
} from "@/mcp-clients";
import type { ConnectionEntity } from "@/tools/connection/schema";
import type { ServerClient } from "@decocms/bindings/mcp";
import {
  createBridgeTransportPair,
  createServerFromClient,
} from "@decocms/mesh-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Context, Hono } from "hono";
import type { MeshContext } from "../../core/mesh-context";
import { handleAuthError } from "./oauth-proxy";
import { handleVirtualMcpRequest } from "./virtual-mcp";

// Define Hono variables type
type Variables = {
  meshContext: MeshContext;
};

const app = new Hono<{ Variables: Variables }>();

// ============================================================================
// MCP Tool Call Configuration
// ============================================================================

/**
 * Default timeout for MCP tool calls in milliseconds.
 * The MCP SDK default is 60 seconds (60000ms).
 * Increase this value for tools that take longer to execute.
 */
export const MCP_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// MCP Proxy Factory
// ============================================================================

/**
 * Create MCP proxy for a downstream connection
 * Pattern from @deco/api proxy() function
 *
 * Single server approach - tools from downstream are dynamically fetched and registered
 *
 * Pure MCP spec-compliant client (no custom extensions)
 */
export type MCPProxyClient = Client & {
  [Symbol.asyncDispose]: () => Promise<void>;
};

/**
 * MCP proxy client with streaming support extension
 * This adds the custom callStreamableTool method for HTTP streaming
 */
export type StreamableMCPProxyClient = MCPProxyClient & {
  callStreamableTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<Response>;
};

/**
 * Convert Client to ServerClient format for bindings compatibility
 * Overloaded to handle both regular and streamable clients
 */
export function toServerClient(
  client: Client,
): Omit<ServerClient, "callStreamableTool">;
export function toServerClient(
  client: ClientWithStreamingSupport,
): ServerClient;
export function toServerClient(
  client: ClientWithOptionalStreamingSupport,
): ServerClient | Omit<ServerClient, "callStreamableTool"> {
  const base = {
    client: {
      callTool: client.callTool.bind(client),
      listTools: client.listTools.bind(client),
    },
  };

  // Only add streaming if present
  if ("callStreamableTool" in client && client.callStreamableTool) {
    return {
      ...base,
      callStreamableTool: client.callStreamableTool.bind(client),
    };
  }

  return base;
}

async function createMCPProxyDoNotUseDirectly(
  connectionIdOrConnection: string | ConnectionEntity,
  ctx: MeshContext,
  { superUser }: { superUser: boolean }, // this is basically used for background workers that needs cross-organization access
): Promise<MCPProxyClient> {
  // Get connection details
  const connection =
    typeof connectionIdOrConnection === "string"
      ? await ctx.storage.connections.findById(
          connectionIdOrConnection,
          ctx.organization?.id,
        )
      : connectionIdOrConnection;
  if (!connection) {
    throw new Error("Connection not found");
  }

  // Validate organization ownership
  if (ctx.organization && connection.organization_id !== ctx.organization.id) {
    throw new Error("Connection does not belong to the active organization");
  }
  ctx.organization ??= { id: connection.organization_id };

  // Check connection status
  if (connection.status !== "active") {
    throw new Error(`Connection inactive: ${connection.status}`);
  }

  // Create base client with auth + monitoring transports
  const baseClient = await clientFromConnection(connection, ctx, superUser);

  // Apply tool caching decorator
  const cachedClient = withToolCaching(baseClient, connection);

  // Create server directly from decorated client
  // Tool caching is handled by the decorated client
  // For VIRTUAL connections (PassthroughClient), getServerCapabilities() returns undefined
  // because the client is synthetic (never connected to a real server).
  // Fall back to default capabilities that include tools/resources/prompts.
  const capabilities = cachedClient.getServerCapabilities() ?? {
    tools: {},
    resources: {},
    prompts: {},
  };
  const server = createServerFromClient(
    cachedClient,
    {
      name: "mcp-mesh-proxy-client",
      version: "1.0.0",
    },
    {
      capabilities,
      instructions: cachedClient.getInstructions(),
    },
  );

  // Create in-memory bridge transport pair for zero-overhead communication
  const { client: clientTransport, server: serverTransport } =
    createBridgeTransportPair();

  // Connect server to server-side transport
  await server.connect(serverTransport);

  // Create client and connect to client-side transport
  const client = new Client({
    name: "mcp-mesh-proxy-client",
    version: "1.0.0",
  });
  await client.connect(clientTransport);

  // Return client as MCPProxyClient (backward compatible)
  return client as MCPProxyClient;
}

/**
 * Create MCP proxy for a downstream connection
 * Pattern from @deco/api proxy() function
 *
 * Single server approach - tools from downstream are dynamically fetched and registered
 */
export async function createMCPProxy(
  connectionIdOrConnection: string | ConnectionEntity,
  ctx: MeshContext,
) {
  return createMCPProxyDoNotUseDirectly(connectionIdOrConnection, ctx, {
    superUser: false,
  });
}

/**
 * Create a MCP proxy for a downstream connection with super user access
 * @param connectionIdOrConnection - The connection ID or connection entity
 * @param ctx - The mesh context
 * @returns The MCP proxy
 */
export async function dangerouslyCreateSuperUserMCPProxy(
  connectionIdOrConnection: string | ConnectionEntity,
  ctx: MeshContext,
) {
  return createMCPProxyDoNotUseDirectly(connectionIdOrConnection, ctx, {
    superUser: true,
  });
}

// ============================================================================
// Route Handlers
// ============================================================================

/**
 * Default MCP endpoint - serves Decopilot virtual MCP (aggregates all org connections)
 *
 * Route: POST /mcp
 * Uses the Decopilot default virtual MCP which excludes Mesh MCP and org registry
 */
app.all("/", async (c) => {
  return handleVirtualMcpRequest(c, undefined);
});

/**
 * Proxy MCP request to a downstream connection
 *
 * Route: POST /mcp/:connectionId
 * Connection IDs are globally unique UUIDs (no project prefix needed)
 */
app.all("/:connectionId", async (c) => {
  const connectionId = c.req.param("connectionId");
  const ctx = c.get("meshContext");

  try {
    try {
      // Fetch connection
      const connection = await ctx.storage.connections.findById(
        connectionId,
        ctx.organization?.id,
      );
      if (!connection) {
        throw new Error("Connection not found");
      }

      // Validate organization ownership
      if (
        ctx.organization &&
        connection.organization_id !== ctx.organization.id
      ) {
        throw new Error(
          "Connection does not belong to the active organization",
        );
      }
      ctx.organization ??= { id: connection.organization_id };

      // Check connection status
      if (connection.status !== "active") {
        throw new Error(`Connection inactive: ${connection.status}`);
      }

      // Create enhanced server directly (no need for bridge - server is used directly!)
      const server = await serverFromConnection(connection, ctx, false);

      // Create HTTP transport
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse:
          c.req.raw.headers.get("Accept")?.includes("application/json") ??
          false,
      });

      // Connect server to transport
      await server.connect(transport);

      // Handle request and cleanup
      return await transport.handleRequest(c.req.raw);
    } catch (error) {
      // Check if this is an auth error - if so, return appropriate 401
      // Note: This only applies to HTTP connections
      const connection = await ctx.storage.connections.findById(
        connectionId,
        ctx.organization?.id,
      );
      if (connection?.connection_url) {
        const authResponse = await handleAuthError({
          error: error as Error & { status?: number },
          reqUrl: new URL(c.req.raw.url),
          connectionId,
          connectionUrl: connection.connection_url,
          headers: {}, // Headers are built internally by createEnhancedServer
        });
        if (authResponse) {
          return authResponse;
        }
      }
      throw error;
    }
  } catch (error) {
    return handleError(error as Error, c);
  }
});

const handleError = (err: Error, c: Context) => {
  if (err.message.includes("not found")) {
    return c.json({ error: err.message }, 404);
  }
  if (err.message.includes("does not belong to the active organization")) {
    return c.json({ error: "Connection not found" }, 404);
  }
  if (err.message.includes("inactive")) {
    return c.json({ error: err.message }, 503);
  }
  return c.json({ error: "Internal server error", message: err.message }, 500);
};

app.all("/:connectionId/call-tool/:toolName", async (c) => {
  const connectionId = c.req.param("connectionId");
  const toolName = c.req.param("toolName");
  const ctx = c.get("meshContext");

  try {
    // Fetch connection and create client directly
    const connection = await ctx.storage.connections.findById(
      connectionId,
      ctx.organization?.id,
    );
    if (!connection) {
      return c.json({ error: "Connection not found" }, 404);
    }

    // Client pool manages lifecycle, no need for await using
    const client = await clientFromConnection(connection, ctx, false);
    const result = await client.callTool({
      name: toolName,
      arguments: await c.req.json(),
    });

    if (result instanceof Response) {
      return result;
    }

    if (result.isError) {
      return new Response(JSON.stringify(result.content), {
        headers: {
          "Content-Type": "application/json",
        },
        status: 500,
      });
    }

    return new Response(
      JSON.stringify(result.structuredContent ?? result.content),
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    return handleError(error as Error, c);
  }
});

export default app;
