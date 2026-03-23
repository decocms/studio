/**
 * Enhanced MCP Server
 *
 * Creates an MCP Server that wraps a client connection with custom behaviors:
 * - Lazy connection: defers MCP handshake until needed (cache hits avoid it entirely)
 * - SWR caching: tool/resource/prompt lists served from NATS KV with background revalidation
 * - Graceful error handling for resources/prompts (returns empty arrays for MethodNotFound)
 * - Uniform capabilities (all servers appear to support tools/resources/prompts)
 *
 * This server can be used directly in proxy routes or bridged to create a Client.
 */

import { MCP_TOOL_CALL_TIMEOUT_MS } from "@/core/constants";
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
import { createLazyClient } from "./lazy-client";
import { getMcpListCache } from "./mcp-list-cache";
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
 * The server wraps a lazy-connecting client that defers the MCP handshake until
 * the first operation that actually needs it. List operations (tools, resources,
 * prompts) are served from NATS KV cache when available, avoiding the ~80-120ms
 * connection cost entirely on cache hits.
 *
 * @param connection - The connection entity to create a server for
 * @param ctx - Mesh context with storage and organization info
 * @param superUser - Whether to create with super-user privileges (cross-org access)
 * @returns An MCP Server ready to be connected to a transport
 *
 * @example
 * ```ts
 * // Use in HTTP proxy route
 * const server = serverFromConnection(connection, ctx, false);
 * const transport = new WebStandardStreamableHTTPServerTransport({});
 * await server.connect(transport);
 * return await transport.handleRequest(req);
 * ```
 */
export function serverFromConnection(
  connection: ConnectionEntity,
  ctx: MeshContext,
  superUser: boolean,
): McpServer {
  // Create lazy client — no MCP connection is established until needed
  const client = createLazyClient(
    connection,
    ctx,
    superUser,
    getMcpListCache() ?? undefined,
  );

  // Create server from client with default capabilities
  const server = createServerFromClient(
    client,
    {
      name: "mcp-mesh-enhanced",
      version: "1.0.0",
    },
    {
      capabilities: DEFAULT_SERVER_CAPABILITIES,
      toolCallTimeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
    },
  );

  // Override listResources handler with graceful error handling
  server.server.setRequestHandler(
    ListResourcesRequestSchema,
    async (): Promise<ListResourcesResult> => {
      return await client
        .listResources()
        .catch(fallbackOnMethodNotFoundError({ resources: [] }));
    },
  );

  // Override listResourceTemplates handler with graceful error handling
  server.server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async (): Promise<ListResourceTemplatesResult> => {
      return await client
        .listResourceTemplates()
        .catch(fallbackOnMethodNotFoundError({ resourceTemplates: [] }));
    },
  );

  // Override listPrompts handler with graceful error handling
  server.server.setRequestHandler(
    ListPromptsRequestSchema,
    async (): Promise<ListPromptsResult> => {
      return await client
        .listPrompts()
        .catch(fallbackOnMethodNotFoundError({ prompts: [] }));
    },
  );

  return server;
}
