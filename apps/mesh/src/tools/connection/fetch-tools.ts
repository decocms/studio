/**
 * Shared utility to fetch tools from an MCP connection
 *
 * Used by create/update to populate tools at save time.
 * Supports HTTP, SSE, and STDIO transports based on connection_type.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  ConnectionParameters,
  HttpConnectionParameters,
  ToolDefinition,
} from "./schema";
import { isStdioParameters } from "./schema";

/**
 * Find the registry list tool name from a tools array.
 * Returns the tool name if found, null otherwise.
 */
export function findRegistryListTool(
  tools: ToolDefinition[] | null | undefined,
): string | null {
  if (!tools || tools.length === 0) return null;

  const preferred = tools.find(
    (t) => t.name === "COLLECTION_REGISTRY_APP_LIST",
  );
  if (preferred) return preferred.name;

  const privateRegistry = tools.find((t) => t.name === "REGISTRY_ITEM_LIST");
  if (privateRegistry) return privateRegistry.name;

  const generic = tools.find(
    (t) =>
      t.name.startsWith("COLLECTION_REGISTRY_APP_") && t.name.endsWith("_LIST"),
  );
  if (generic) return generic.name;

  return null;
}

/**
 * Minimal connection data needed for tool fetching
 */
export interface ConnectionForToolFetch {
  id: string;
  title: string;
  connection_type: "HTTP" | "SSE" | "Websocket" | "STDIO" | "VIRTUAL";
  connection_url?: string | null;
  connection_token?: string | null;
  connection_headers?: ConnectionParameters | null;
}

/**
 * Result of fetching data from an MCP connection
 */
export interface FetchedMCPData {
  tools: ToolDefinition[] | null;
  scopes: string[] | null;
}

/**
 * Fetches tools and configuration scopes from an MCP connection server.
 * Supports HTTP, SSE, and STDIO transports based on connection_type.
 * VIRTUAL connections return null since tools are fetched dynamically at runtime.
 *
 * @param connection - Connection details for connecting to MCP
 * @returns Fetched tools and scopes, or null if fetch failed or not applicable
 */
export async function fetchToolsFromMCP(
  connection: ConnectionForToolFetch,
): Promise<FetchedMCPData | null> {
  switch (connection.connection_type) {
    case "STDIO":
      return fetchToolsFromStdioMCP(connection);
    case "HTTP":
    case "Websocket":
      return fetchToolsFromHttpMCP(connection);
    case "SSE":
      return fetchToolsFromSSEMCP(connection);
    case "VIRTUAL":
      // VIRTUAL connections aggregate tools from their underlying Virtual MCP
      // Tools are fetched dynamically at runtime, not cached at creation time
      return null;
    default:
      return null;
  }
}

/**
 * Try to fetch configuration scopes from the MCP_CONFIGURATION tool.
 * Returns null if the tool is not implemented or the call fails.
 */
async function fetchScopesFromMCP(client: Client): Promise<string[] | null> {
  try {
    const configTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("MCP_CONFIGURATION timeout")), 5_000),
    );
    const configResult = await Promise.race([
      client.callTool({ name: "MCP_CONFIGURATION", arguments: {} }),
      configTimeout,
    ]);
    if (!configResult.isError && Array.isArray(configResult.content)) {
      const textContent = configResult.content.find(
        (c: { type: string }) => c.type === "text",
      );
      if (textContent && "text" in textContent) {
        const config = JSON.parse(String(textContent.text));
        if (Array.isArray(config.scopes) && config.scopes.length > 0) {
          return config.scopes as string[];
        }
      }
    }
  } catch {
    // MCP_CONFIGURATION not implemented or failed — not all MCPs support it
  }
  return null;
}

/**
 * Fetch tools from an HTTP-based MCP connection
 */
async function fetchToolsFromHttpMCP(
  connection: ConnectionForToolFetch,
): Promise<FetchedMCPData | null> {
  if (!connection.connection_url) {
    console.error(`HTTP connection ${connection.id} missing URL`);
    return null;
  }

  let client: Client | null = null;

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (connection.connection_token) {
      headers.Authorization = `Bearer ${connection.connection_token}`;
    }

    // Add custom headers from connection_headers
    const httpParams =
      connection.connection_headers as HttpConnectionParameters | null;
    if (httpParams?.headers) {
      Object.assign(headers, httpParams.headers);
    }

    const transport = new StreamableHTTPClientTransport(
      new URL(connection.connection_url),
      { requestInit: { headers } },
    );

    client = new Client({
      name: "mcp-cms-tool-fetcher",
      version: "1.0.0",
    });

    // Add timeout to prevent hanging connections
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Connection timeout")), 10_000);
    });

    await Promise.race([client.connect(transport), timeoutPromise]);
    const result = await Promise.race([client.listTools(), timeoutPromise]);

    const tools =
      result.tools && result.tools.length > 0
        ? result.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? undefined,
            inputSchema: tool.inputSchema ?? {},
            outputSchema: tool.outputSchema
              ? // We strive to have lenient output schemas, so allow additional properties
                { ...tool.outputSchema, additionalProperties: true }
              : undefined,
            annotations: tool.annotations ?? undefined,
            _meta: tool._meta ?? undefined,
          }))
        : null;

    const scopes = await fetchScopesFromMCP(client);

    return { tools, scopes };
  } catch (error) {
    console.error(
      `Failed to fetch tools from HTTP connection ${connection.id}:`,
      error,
    );
    return null;
  } finally {
    try {
      if (client && typeof client.close === "function") {
        await client.close();
      }
    } catch (error) {
      console.warn(`Failed to close HTTP client for ${connection.id}:`, error);
    }
  }
}

/**
 * Fetch tools from an SSE-based MCP connection
 */
async function fetchToolsFromSSEMCP(
  connection: ConnectionForToolFetch,
): Promise<FetchedMCPData | null> {
  if (!connection.connection_url) {
    console.error(`SSE connection ${connection.id} missing URL`);
    return null;
  }

  let client: Client | null = null;

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (connection.connection_token) {
      headers.Authorization = `Bearer ${connection.connection_token}`;
    }

    const httpParams =
      connection.connection_headers as HttpConnectionParameters | null;
    if (httpParams?.headers) {
      Object.assign(headers, httpParams.headers);
    }

    const transport = new SSEClientTransport(
      new URL(connection.connection_url),
      { requestInit: { headers } },
    );

    client = new Client({ name: "mcp-cms-tool-fetcher", version: "1.0.0" });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("SSE connection timeout")), 15_000);
    });

    await Promise.race([client.connect(transport), timeoutPromise]);
    const result = await Promise.race([client.listTools(), timeoutPromise]);

    const tools =
      result.tools && result.tools.length > 0
        ? result.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? undefined,
            inputSchema: tool.inputSchema ?? {},
            outputSchema: tool.outputSchema
              ? { ...tool.outputSchema, additionalProperties: true }
              : undefined,
            annotations: tool.annotations ?? undefined,
            _meta: tool._meta ?? undefined,
          }))
        : null;

    const scopes = await fetchScopesFromMCP(client);

    return { tools, scopes };
  } catch (error) {
    console.error(
      `Failed to fetch tools from SSE connection ${connection.id}:`,
      error,
    );
    return null;
  } finally {
    try {
      await client?.close();
    } catch (error) {
      console.warn(`Failed to close SSE client for ${connection.id}:`, error);
    }
  }
}

/**
 * Fetch tools from a STDIO-based MCP connection
 */
async function fetchToolsFromStdioMCP(
  connection: ConnectionForToolFetch,
): Promise<FetchedMCPData | null> {
  const stdioParams = isStdioParameters(connection.connection_headers)
    ? connection.connection_headers
    : null;

  if (!stdioParams) {
    console.error(`STDIO connection ${connection.id} missing parameters`);
    return null;
  }

  let client: Client | null = null;

  try {
    const transport = new StdioClientTransport({
      command: stdioParams.command,
      args: stdioParams.args,
      env: stdioParams.envVars,
      cwd: stdioParams.cwd,
    });

    client = new Client({
      name: "mcp-cms-tool-fetcher",
      version: "1.0.0",
    });

    // Add timeout to prevent hanging
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Tool fetch timeout")), 10_000);
    });

    await Promise.race([client.connect(transport), timeoutPromise]);
    const result = await Promise.race([client.listTools(), timeoutPromise]);

    const tools =
      result.tools && result.tools.length > 0
        ? result.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? undefined,
            inputSchema: tool.inputSchema ?? {},
            outputSchema: tool.outputSchema ?? undefined,
            annotations: tool.annotations ?? undefined,
            _meta: tool._meta ?? undefined,
          }))
        : null;

    const scopes = await fetchScopesFromMCP(client);

    return { tools, scopes };
  } catch (error) {
    console.error(
      `Failed to fetch tools from STDIO connection ${connection.id}:`,
      error,
    );
    return null;
  } finally {
    try {
      if (client && typeof client.close === "function") {
        await client.close();
      }
    } catch (error) {
      console.warn(`Failed to close STDIO client for ${connection.id}:`, error);
    }
  }
}
