/**
 * MCP Proxy Factory
 *
 * Extracted from proxy.ts to break the circular import:
 * context-factory → proxy → oauth-proxy → context-factory
 *
 * This module has no dependency on oauth-proxy or context-factory,
 * so both can safely import from here.
 */

import { createLazyClient } from "@/mcp-clients/lazy-client";
import { getMcpListCache } from "@/mcp-clients/mcp-list-cache";
import type { ConnectionEntity } from "@/tools/connection/schema";
import type { ServerClient } from "@decocms/bindings/mcp";
import {
  createBridgeTransportPair,
  createServerFromClient,
} from "@decocms/mesh-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MCP_TOOL_CALL_TIMEOUT_MS } from "@/core/constants";
import type { StudioContext } from "../../core/studio-context";

// ============================================================================
// Types
// ============================================================================

/**
 * Pure MCP spec-compliant client (no custom extensions)
 */
export type MCPProxyClient = Client & {
  [Symbol.asyncDispose]: () => Promise<void>;
};

// ============================================================================
// Utilities
// ============================================================================

/**
 * Convert Client to ServerClient format for bindings compatibility
 */
export function toServerClient(client: Client): ServerClient {
  return {
    client: {
      callTool: client.callTool.bind(client),
      listTools: client.listTools.bind(client),
    },
  };
}

// ============================================================================
// Factory Functions
// ============================================================================

async function createMCPProxyDoNotUseDirectly(
  connectionIdOrConnection: string | ConnectionEntity,
  ctx: StudioContext,
  { superUser }: { superUser: boolean }, // this is basically used for background workers that needs cross-organization access
): Promise<MCPProxyClient> {
  // Non-superUser callers (user-facing tools) must have org context;
  // without it the ownership check would be skipped, enabling cross-tenant access.
  if (!superUser && !ctx.organization?.id) {
    throw new Error("Organization context is required");
  }

  // Get connection details — scope the lookup to the caller's org when available
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

  // Super-user background workers may lack org context; populate it from the connection.
  if (!ctx.organization) {
    const org = await ctx.db
      .selectFrom("organization")
      .select(["id", "slug", "name"])
      .where("id", "=", connection.organization_id)
      .executeTakeFirst();
    ctx.organization = org
      ? { id: org.id, slug: org.slug, name: org.name }
      : { id: connection.organization_id };
  }

  // Check connection status
  if (connection.status !== "active") {
    throw new Error(`Connection inactive: ${connection.status}`);
  }

  // Create lazy client — defers MCP handshake until needed (cache hits avoid it)
  const cachedClient = createLazyClient(
    connection,
    ctx,
    superUser,
    getMcpListCache() ?? undefined,
  );

  // Create server from lazy client with default capabilities
  // The lazy client placeholder has no server capabilities (never connected),
  // so we always provide defaults that include tools/resources/prompts.
  const server = createServerFromClient(
    cachedClient,
    {
      name: "mcp-cms-proxy-client",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      toolCallTimeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
    },
  );

  // Create in-memory bridge transport pair for zero-overhead communication
  const { client: clientTransport, server: serverTransport } =
    createBridgeTransportPair();

  // Connect server to server-side transport
  await server.connect(serverTransport);

  // Create client and connect to client-side transport
  const client = new Client({
    name: "mcp-cms-proxy-client",
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
  ctx: StudioContext,
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
  ctx: StudioContext,
) {
  return createMCPProxyDoNotUseDirectly(connectionIdOrConnection, ctx, {
    superUser: true,
  });
}
