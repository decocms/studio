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
 * import { createServerFromClient } from "@decocms/mcp-utils";
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

import type { IClient } from "./client-like.ts";
import {
  llmSafeInputSchema,
  restoreOriginalKeys,
} from "./llm-safe-property-keys.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sharedJsonSchemaValidator } from "./shared-schema-validator.ts";
import type {
  Implementation,
  ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
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
  /**
   * Timeout in milliseconds for tool calls forwarded to the client.
   * If not provided, the MCP SDK default (60s) is used.
   */
  toolCallTimeoutMs?: number;
}

/**
 * Creates an MCP Server that delegates all requests to the provided Client.
 *
 * @param client - The MCP Client to delegate requests to
 * @param serverInfo - Server metadata (ImplementationSchema-compatible: name, version, title, description, icons, websiteUrl)
 * @param options - Optional server configuration (capabilities and instructions)
 * @returns An MCP Server instance configured to delegate to the client
 */
export function createServerFromClient(
  client: IClient,
  serverInfo: Implementation,
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
    // Share one content-memoized validator so the SDK doesn't mint a fresh Ajv
    // (with an ever-growing compile cache) per server instance. See
    // shared-schema-validator.ts.
    jsonSchemaValidator: sharedJsonSchemaValidator,
  });

  // Set up request handlers that delegate to client methods

  // Tools handlers
  // Strip outputSchema from tools so downstream clients (e.g. the browser's
  // MCP Client) don't cache validators and reject structuredContent that
  // doesn't perfectly match the downstream server's declared schema.
  // A proxy should pass through responses as-is — validation is the
  // responsibility of the originating server, not intermediaries.
  //
  // Property keys an upstream server is free to use (`{fieldName}`,
  // `request.paymentDetails[0].id`, `"group "`) make Anthropic reject the
  // ENTIRE request, so one such tool anywhere in the org silences every run of
  // a client that forwards our listing verbatim (the Claude Code SDK does).
  // Rename them here — the one place every MCP client reads through — and undo
  // the renaming on the call, so upstream still sees its own key names.
  const keyMaps = new Map<string, Map<string, string>>();
  let listed = false;

  /** Rewrite unsafe keys, remembering how to undo it per tool. */
  const toSafeTools = (
    tools: Awaited<ReturnType<IClient["listTools"]>>["tools"],
  ) =>
    tools.map(({ outputSchema: _, ...tool }) => {
      const { schema, keyMap } = llmSafeInputSchema(tool.inputSchema);
      if (keyMap.size === 0) {
        keyMaps.delete(tool.name);
        return tool;
      }
      keyMaps.set(tool.name, keyMap);
      return { ...tool, inputSchema: schema as typeof tool.inputSchema };
    });

  server.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const result = await client.listTools(request.params);
    const tools = toSafeTools(result.tools);
    // Only an unpaginated listing describes every tool; a single page must not
    // be mistaken for one when restoring a call's arguments.
    listed ||= request.params?.cursor == null && result.nextCursor == null;
    return { ...result, tools };
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // A client that calls without listing first has no map yet — build it once.
    // `listTools` is cached upstream, so this costs a round-trip at most once
    // per bridge.
    if (!listed && request.params.arguments) {
      const result = await client.listTools({});
      toSafeTools(result.tools);
      listed = result.nextCursor == null;
    }
    const keyMap = keyMaps.get(request.params.name);
    const params =
      keyMap && request.params.arguments
        ? {
            ...request.params,
            arguments: restoreOriginalKeys(request.params.arguments, keyMap),
          }
        : request.params;
    return client.callTool(
      params,
      undefined,
      options?.toolCallTimeoutMs
        ? { timeout: options.toolCallTimeoutMs }
        : undefined,
    );
  });

  // Resources handlers (only if capabilities include resources)
  if (capabilities?.resources) {
    server.server.setRequestHandler(ListResourcesRequestSchema, (request) =>
      client.listResources(request.params),
    );

    server.server.setRequestHandler(ReadResourceRequestSchema, (request) =>
      client.readResource(request.params),
    );

    server.server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      (request) => client.listResourceTemplates(request.params),
    );
  }

  // Prompts handlers (only if capabilities include prompts)
  if (capabilities?.prompts) {
    server.server.setRequestHandler(ListPromptsRequestSchema, (request) =>
      client.listPrompts(request.params),
    );

    server.server.setRequestHandler(GetPromptRequestSchema, (request) =>
      client.getPrompt({
        ...request.params,
        arguments: request.params.arguments ?? {},
      }),
    );
  }

  return server;
}
