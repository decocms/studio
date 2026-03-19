/**
 * Authorization Transport
 *
 * Intercepts tool calls to check permissions before forwarding to downstream.
 * Uses NATS KV cached tools metadata for public tool checks,
 * falling back to a live tools/list request on cache miss.
 */

import type { MeshContext } from "@/core/mesh-context";
import {
  type McpListCache,
  getMcpListCache,
} from "@/mcp-clients/mcp-list-cache";
import type { ConnectionEntity } from "@/tools/connection/schema";
import { AccessControl } from "@/core/access-control";
import type {
  JSONRPCMessage,
  JSONRPCRequest,
  CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { WrapperTransport } from "./compose";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const MCP_MESH_KEY = "mcp.mesh";

interface AuthTransportOptions {
  ctx: MeshContext;
  connection: ConnectionEntity;
  superUser?: boolean;
  cache?: McpListCache;
}

export class AuthTransport extends WrapperTransport {
  constructor(
    innerTransport: Transport,
    private options: AuthTransportOptions,
  ) {
    super(innerTransport);
  }

  private toolsListPromise: Promise<unknown[] | null> | null = null;

  /**
   * Fetch tools by sending a tools/list JSON-RPC request through the inner transport.
   * Single-flighted: concurrent callers share the same in-flight request.
   */
  private fetchToolsFromServer(): Promise<unknown[] | null> {
    if (!this.toolsListPromise) {
      this.toolsListPromise = new Promise<unknown[] | null>((resolve) => {
        const requestId = `auth-tools-${Date.now()}`;
        const prev = this.innerTransport.onmessage;

        this.innerTransport.onmessage = (message: JSONRPCMessage) => {
          if (
            "id" in message &&
            message.id === requestId &&
            "result" in message
          ) {
            this.innerTransport.onmessage = prev;
            this.toolsListPromise = null;
            const tools =
              (message.result as { tools?: unknown[] })?.tools ?? null;
            resolve(tools);
          } else {
            prev?.(message);
          }
        };

        this.innerTransport
          .send({
            jsonrpc: "2.0",
            id: requestId,
            method: "tools/list",
            params: {},
          } as JSONRPCMessage)
          .catch(() => {
            this.innerTransport.onmessage = prev;
            this.toolsListPromise = null;
            resolve(null);
          });
      });
    }
    return this.toolsListPromise;
  }

  private async ensureToolsMap(): Promise<Map<string, any>> {
    const cache = this.options.cache ?? getMcpListCache();

    // Try NATS KV cache first
    let tools: unknown[] | null = cache
      ? await cache.get("tools", this.options.connection.id)
      : null;

    // Cache miss: fetch live from the downstream MCP server
    if (!tools) {
      tools = await this.fetchToolsFromServer();
      if (tools && cache) {
        cache.set("tools", this.options.connection.id, tools).catch(() => {});
      }
    }

    if (!tools) {
      return new Map();
    }

    return new Map((tools as Array<{ name: string }>).map((t) => [t.name, t]));
  }

  protected override async handleOutgoingMessage(
    message: JSONRPCMessage,
  ): Promise<void> {
    // Only intercept requests (not responses/notifications)
    if (!this.isRequest(message)) {
      return this.innerTransport.send(message);
    }

    const request = message as JSONRPCRequest;

    // Intercept tools/call for authorization
    if (request.method === "tools/call") {
      await this.authorizeToolCall(request);
      this.stripMetaFromArguments(request);
    }

    return this.innerTransport.send(message);
  }

  private async authorizeToolCall(request: JSONRPCRequest): Promise<void> {
    // Skip auth for superUser mode (background workers)
    if (this.options.superUser) {
      return;
    }

    const params = request.params as CallToolRequest["params"];
    const toolName = params.name;
    const { ctx, connection } = this.options;

    // Check if tool is public (using cached metadata)
    if (await this.isPublicTool(toolName)) {
      return; // Public tools skip auth
    }

    // Check authentication
    if (!ctx.auth.user?.id && !ctx.auth.apiKey?.id) {
      throw new Error(
        "Authentication required. Please provide a valid OAuth token or API key.",
      );
    }

    // Create getToolMeta callback for AccessControl
    const getToolMeta = async () => {
      const toolsMap = await this.ensureToolsMap();
      const tool = toolsMap.get(toolName);
      return tool?._meta as Record<string, unknown> | undefined;
    };

    // Create AccessControl with connectionId set
    // This checks: does user have permission for this TOOL on this CONNECTION?
    const connectionAccessControl = new AccessControl(
      ctx.authInstance,
      ctx.auth.user?.id ?? ctx.auth.apiKey?.userId,
      toolName, // Tool being called
      ctx.boundAuth, // Bound auth client (encapsulates headers)
      ctx.auth.user?.role, // Role for built-in role bypass
      connection.id, // Connection ID for permission check
      getToolMeta, // Callback for public tool check
    );

    await connectionAccessControl.check(toolName);
  }

  private async isPublicTool(toolName: string): Promise<boolean> {
    if (toolName.startsWith("MESH_PUBLIC_")) {
      return true;
    }

    const toolsMap = await this.ensureToolsMap();
    const tool = toolsMap.get(toolName);
    if (!tool?._meta) {
      return false;
    }

    const meshMeta = tool._meta[MCP_MESH_KEY];
    return meshMeta?.public_tool === true;
  }

  private stripMetaFromArguments(request: JSONRPCRequest): void {
    const params = request.params as CallToolRequest["params"];
    if (params.arguments && "_meta" in params.arguments) {
      const { _meta, ...rest } = params.arguments;
      params.arguments = rest;
    }
  }
}
