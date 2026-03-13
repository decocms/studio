/**
 * Server-Client Bridge
 *
 * Creates an MCP Server that delegates all requests to an MCP Client.
 * This allows using a Client as if it were a Server, useful for proxying
 * or bridging between different transport layers.
 *
 * ## Usage
 *
 * ```ts
 * import { createServerFromClient } from "@decocms/mesh-sdk";
 * import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 * import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
 *
 * const client = new Client(...);
 * await client.connect(clientTransport);
 *
 * const server = createServerFromClient(
 *   client,
 *   { name: "proxy-server", version: "1.0.0" }
 * );
 *
 * const transport = new WebStandardStreamableHTTPServerTransport({});
 * await server.connect(transport);
 *
 * // Handle requests via transport.handleRequest(req)
 * ```
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Options for creating a server from a client
 */
export interface ServerFromClientOptions {
  /**
   * Server capabilities. If not provided, uses client.getServerCapabilities()
   */
  capabilities?: ServerCapabilities;
  /**
   * Server instructions. If not provided, uses client.getInstructions()
   */
  instructions?: string;
}

/**
 * Creates an MCP Server that delegates all requests to the provided Client.
 *
 * @param client - The MCP Client to delegate requests to
 * @param serverInfo - Server metadata (name and version)
 * @param options - Optional server configuration (capabilities and instructions)
 * @returns An MCP Server instance configured to delegate to the client
 */
export function createServerFromClient(
  client: Client,
  serverInfo: { name: string; version: string },
  options?: ServerFromClientOptions,
): McpServer {
  // Get capabilities from client if not provided
  const capabilities = options?.capabilities ?? client.getServerCapabilities();

  // Get instructions from client if not provided
  const instructions = options?.instructions ?? client.getInstructions();

  // Create MCP server with capabilities and instructions
  const server = new McpServer(serverInfo, {
    capabilities,
    instructions,
  });

  // Set up request handlers that delegate to client methods

  // Tools handlers
  server.server.setRequestHandler(ListToolsRequestSchema, () =>
    client.listTools(),
  );

  server.server.setRequestHandler(CallToolRequestSchema, (request) =>
    client.callTool(request.params),
  );

  // Resources handlers (only if capabilities include resources)
  if (capabilities?.resources) {
    server.server.setRequestHandler(ListResourcesRequestSchema, () =>
      client.listResources(),
    );

    server.server.setRequestHandler(ReadResourceRequestSchema, (request) =>
      client.readResource(request.params),
    );

    server.server.setRequestHandler(ListResourceTemplatesRequestSchema, () =>
      client.listResourceTemplates(),
    );
  }

  // Prompts handlers (only if capabilities include prompts)
  if (capabilities?.prompts) {
    server.server.setRequestHandler(ListPromptsRequestSchema, () =>
      client.listPrompts(),
    );

    server.server.setRequestHandler(GetPromptRequestSchema, (request) =>
      client.getPrompt(request.params),
    );
  }

  return server;
}
