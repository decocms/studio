/**
 * Shared utility to fetch tools from an MCP connection
 *
 * Used by create/update to populate tools at save time.
 * Supports HTTP, SSE, and STDIO transports based on connection_type.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { sharedJsonSchemaValidator } from "@decocms/mcp-utils";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getSettings } from "../../settings";
import {
  createNoRedirectFetch,
  guardAgainstPrivateUrl,
} from "../registry/discover-tools";
import type { ConnectionParameters, ToolDefinition } from "./schema";
import { isStdioParameters } from "./schema";

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
 * Builds the request headers (bearer token + custom headers) shared by the
 * HTTP and SSE transports. `connection_headers` is typed as a union with
 * STDIO params, so narrow it with `isStdioParameters` instead of casting.
 */
/**
 * Races `promise` against a timeout, clearing the timer either way so a
 * resolved/rejected call doesn't leave a dangling timeout running for the
 * full duration (these fetches happen per-connection on create/update).
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

export function buildConnectionRequestHeaders(
  connection: ConnectionForToolFetch,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (connection.connection_token) {
    headers.Authorization = `Bearer ${connection.connection_token}`;
  }

  const params = connection.connection_headers;
  if (params && !isStdioParameters(params) && params.headers) {
    Object.assign(headers, params.headers);
  }

  return headers;
}

/**
 * Try to fetch configuration scopes from the MCP_CONFIGURATION tool.
 * Returns null if the tool is not implemented or the call fails.
 */
async function fetchScopesFromMCP(client: Client): Promise<string[] | null> {
  try {
    const configResult = await withTimeout(
      client.callTool({ name: "MCP_CONFIGURATION", arguments: {} }),
      5_000,
      "MCP_CONFIGURATION timeout",
    );
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

  // connection_url is user-supplied — without this guard a connection
  // create/update call could reach a private/metadata address that the
  // registry discovery flow already blocks for the same URL.
  const guardError = await guardAgainstPrivateUrl(connection.connection_url);
  if (guardError) {
    console.error(`Blocked HTTP connection ${connection.id}: ${guardError}`);
    return null;
  }

  let client: Client | null = null;

  try {
    const headers = buildConnectionRequestHeaders(connection);

    const transport = new StreamableHTTPClientTransport(
      new URL(connection.connection_url),
      { requestInit: { headers }, fetch: createNoRedirectFetch() },
    );

    client = new Client(
      {
        name: "mcp-cms-tool-fetcher",
        version: "1.0.0",
      },
      { jsonSchemaValidator: sharedJsonSchemaValidator },
    );

    await withTimeout(client.connect(transport), 10_000, "Connection timeout");
    const result = await withTimeout(
      client.listTools(),
      10_000,
      "Connection timeout",
    );

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

  const guardError = await guardAgainstPrivateUrl(connection.connection_url);
  if (guardError) {
    console.error(`Blocked SSE connection ${connection.id}: ${guardError}`);
    return null;
  }

  let client: Client | null = null;

  try {
    const headers = buildConnectionRequestHeaders(connection);

    const transport = new SSEClientTransport(
      new URL(connection.connection_url),
      { requestInit: { headers }, fetch: createNoRedirectFetch() },
    );

    client = new Client(
      { name: "mcp-cms-tool-fetcher", version: "1.0.0" },
      { jsonSchemaValidator: sharedJsonSchemaValidator },
    );

    await withTimeout(
      client.connect(transport),
      15_000,
      "SSE connection timeout",
    );
    const result = await withTimeout(
      client.listTools(),
      15_000,
      "SSE connection timeout",
    );

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
 * Fetch tools from a STDIO-based MCP connection.
 * Guarded by localMode — STDIO spawns arbitrary commands as child processes.
 */
async function fetchToolsFromStdioMCP(
  connection: ConnectionForToolFetch,
): Promise<FetchedMCPData | null> {
  // Defense-in-depth: callers should check localMode before reaching here,
  // but reject anyway to prevent any code path from spawning commands in
  // production deployments.
  if (!getSettings().localMode) {
    console.error(
      `[fetch-tools] Blocked STDIO spawn for ${connection.id}: not in local mode`,
    );
    return null;
  }

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

    client = new Client(
      {
        name: "mcp-cms-tool-fetcher",
        version: "1.0.0",
      },
      { jsonSchemaValidator: sharedJsonSchemaValidator },
    );

    await withTimeout(client.connect(transport), 10_000, "Tool fetch timeout");
    const result = await withTimeout(
      client.listTools(),
      10_000,
      "Tool fetch timeout",
    );

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
