/**
 * Call management MCP tools from a Playwright test via JSON-RPC.
 *
 * Mesh exposes built-in tools (CONNECTION_*, PROJECT_*, etc.) over the
 * MCP protocol at `/api/:org/mcp/self`. From a spec, we sometimes need to
 * exercise them as setup — e.g., create a connection that points at a
 * test MCP server (see `test-mcp-server.ts`). This module wraps the
 * JSON-RPC dance so callers don't repeat the envelope.
 *
 * The server-side handler at `apps/mesh/src/api/routes/self.ts` builds a
 * fresh MCP server per request, so each call is self-contained — no
 * explicit `initialize` handshake is needed when `Accept: application/json`
 * is set (the JSON-response mode in the SDK's streamable HTTP transport).
 */

import type { APIRequestContext } from "@playwright/test";

interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    structuredContent?: T;
  };
  error?: { code: number; message: string; data?: unknown };
}

let nextRpcId = 1;

/**
 * Invoke a self MCP tool by name. Returns the structuredContent if the
 * server provided it, otherwise the parsed first text-content block.
 * Throws on JSON-RPC error or `result.isError === true`.
 */
export async function callSelfMcpTool<T = unknown>(
  request: APIRequestContext,
  orgSlug: string,
  name: string,
  args: unknown,
): Promise<T> {
  const res = await request.post(`/api/${orgSlug}/mcp/self`, {
    data: {
      jsonrpc: "2.0",
      id: nextRpcId++,
      method: "tools/call",
      params: { name, arguments: args },
    },
    headers: { Accept: "application/json" },
  });
  if (!res.ok()) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`callSelfMcpTool ${name}: HTTP ${res.status()} — ${body}`);
  }
  const envelope = (await res.json()) as JsonRpcResponse<T>;
  if (envelope.error) {
    throw new Error(
      `callSelfMcpTool ${name}: JSON-RPC error ${envelope.error.code} — ${envelope.error.message}`,
    );
  }
  const result = envelope.result;
  if (!result) {
    throw new Error(`callSelfMcpTool ${name}: missing result in response`);
  }
  if (result.isError) {
    const errText = result.content?.[0]?.text ?? "<no text>";
    throw new Error(
      `callSelfMcpTool ${name}: tool returned error — ${errText}`,
    );
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const text = result.content?.[0]?.text;
  if (text === undefined) {
    throw new Error(`callSelfMcpTool ${name}: no content in response`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export interface CreateHttpConnectionArgs {
  title: string;
  description?: string;
  url: string;
  token?: string;
}

export interface CreatedConnection {
  id: string;
  title: string;
  connection_type: string;
  connection_url: string;
}

/**
 * Convenience wrapper around COLLECTION_CONNECTIONS_CREATE for the common
 * "HTTP connection pointing at a test MCP server" pattern.
 */
export async function createHttpConnection(
  request: APIRequestContext,
  orgSlug: string,
  args: CreateHttpConnectionArgs,
): Promise<CreatedConnection> {
  const response = await callSelfMcpTool<{ item: CreatedConnection }>(
    request,
    orgSlug,
    "COLLECTION_CONNECTIONS_CREATE",
    {
      data: {
        title: args.title,
        description: args.description,
        connection_type: "HTTP",
        connection_url: args.url,
        connection_token: args.token,
      },
    },
  );
  if (!response.item?.id) {
    throw new Error(
      `createHttpConnection: response missing item.id — ${JSON.stringify(response)}`,
    );
  }
  return response.item;
}
