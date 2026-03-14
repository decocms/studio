/**
 * MCP Serve Command
 *
 * Starts an MCP stdio server that proxies to a running Mesh instance.
 * This allows AI agents (Claude Code, Cursor, etc.) to use Mesh tools
 * via the standard stdio MCP transport.
 *
 * Usage:
 *   deco mcp-serve -w <workspace>
 *   deco mcp-serve --url http://localhost:3000/mcp --token <api-key>
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export interface McpServeOptions {
  workspace?: string;
  integration?: string;
  local?: boolean;
  url?: string;
  token?: string;
}

export async function mcpServeCommand(options: McpServeOptions) {
  const { workspace, integration, local, url: directUrl } = options;
  const token = options.token || process.env.DECO_API_KEY;

  let client: Client;

  if (directUrl) {
    // Direct URL mode — connect to arbitrary MCP endpoint
    const headers: Record<string, string> = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    // Do NOT forward session auth to arbitrary URLs — require explicit --token

    client = new Client({ name: "deco-mcp-serve", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(directUrl), {
        requestInit: { headers },
      }),
    );
  } else {
    // Workspace mode — use standard workspace client
    const { createWorkspaceClient } = await import("../../lib/mcp.js");
    client = await createWorkspaceClient({
      workspace,
      local,
      integrationId: integration,
    });
  }

  // Bridge client → server
  const capabilities = client.getServerCapabilities();
  const instructions = client.getInstructions();

  const server = new McpServer(
    { name: "deco-mesh", version: "1.0.0" },
    { capabilities, instructions },
  );

  server.server.setRequestHandler(ListToolsRequestSchema, () =>
    client.listTools(),
  );
  server.server.setRequestHandler(CallToolRequestSchema, (request) =>
    client.callTool(request.params),
  );

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

  if (capabilities?.prompts) {
    server.server.setRequestHandler(ListPromptsRequestSchema, () =>
      client.listPrompts(),
    );
    server.server.setRequestHandler(GetPromptRequestSchema, (request) =>
      client.getPrompt(request.params),
    );
  }

  // Serve over stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Keep alive until stdin closes
  process.stdin.on("end", () => {
    client.close().catch(() => {});
    process.exit(0);
  });
}
