/**
 * Enhanced MCP Server
 *
 * Creates an MCP Server that wraps a client connection with custom behaviors:
 * - Indexed tools optimization (uses cached DB tools when available)
 * - Graceful error handling for resources/prompts (returns empty arrays for MethodNotFound)
 * - Uniform capabilities (all servers appear to support tools/resources/prompts)
 *
 * This server can be used directly in proxy routes or bridged to create a Client.
 */

import type { ConnectionEntity } from "@/tools/connection/schema";
import { createServerFromClient } from "@decocms/mesh-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ListPromptsResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MeshContext } from "../core/mesh-context";
import { clientFromConnection } from "./client";
import { fallbackOnMethodNotFoundError } from "./utils";

/**
 * Default server capabilities that all enhanced servers expose.
 * This ensures a uniform API for clients - all connections appear to support
 * tools, resources, and prompts even if the underlying server doesn't.
 */
const DEFAULT_SERVER_CAPABILITIES = {
  tools: {},
  resources: {},
  prompts: {},
};

/**
 * Creates an enhanced MCP Server with custom request handlers from a connection.
 *
 * The server wraps a client connection and adds:
 * - Graceful error handling for optional features
 * - Uniform capabilities for consistent client experience
 *
 * Note: Tool caching should be applied via the withToolCaching decorator
 * before creating the client if caching is desired.
 *
 * @param connection - The connection entity to create a server for
 * @param ctx - Mesh context with storage and organization info
 * @param superUser - Whether to create with super-user privileges (cross-org access)
 * @returns An MCP Server ready to be connected to a transport
 *
 * @example
 * ```ts
 * // Use in HTTP proxy route
 * const server = await serverFromConnection(connection, ctx, false);
 * const transport = new WebStandardStreamableHTTPServerTransport({});
 * await server.connect(transport);
 * return await transport.handleRequest(req);
 * ```
 */
export async function serverFromConnection(
  connection: ConnectionEntity,
  ctx: MeshContext,
  superUser: boolean,
): Promise<McpServer> {
  // Create base client with auth + monitoring transports
  const baseClient = await clientFromConnection(connection, ctx, superUser);

  // Create server from client with default capabilities
  const server = createServerFromClient(
    baseClient,
    {
      name: "mcp-mesh-enhanced",
      version: "1.0.0",
    },
    {
      capabilities: DEFAULT_SERVER_CAPABILITIES,
      instructions: baseClient.getInstructions(),
    },
  );

  // Override listResources handler with graceful error handling
  server.server.setRequestHandler(
    ListResourcesRequestSchema,
    async (): Promise<ListResourcesResult> => {
      return await baseClient
        .listResources()
        .catch(fallbackOnMethodNotFoundError({ resources: [] }));
    },
  );

  // Override listResourceTemplates handler with graceful error handling
  server.server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async (): Promise<ListResourceTemplatesResult> => {
      return await baseClient
        .listResourceTemplates()
        .catch(fallbackOnMethodNotFoundError({ resourceTemplates: [] }));
    },
  );

  // Override listPrompts handler with graceful error handling
  server.server.setRequestHandler(
    ListPromptsRequestSchema,
    async (): Promise<ListPromptsResult> => {
      return await baseClient
        .listPrompts()
        .catch(fallbackOnMethodNotFoundError({ prompts: [] }));
    },
  );

  return server;
}
