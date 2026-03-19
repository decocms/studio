/**
 * Authorization Transport
 *
 * Intercepts tool calls to check permissions before forwarding to downstream.
 * Uses cached connection.tools metadata for public tool checks.
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
  private cachedToolsMap: Map<string, any> | null = null;
  private toolsMapPromise: Promise<Map<string, any>> | null = null;

  constructor(
    innerTransport: Transport,
    private options: AuthTransportOptions,
  ) {
    super(innerTransport);

    // Pre-build tool metadata map from cached connection.tools
    if (options.connection.tools) {
      this.cachedToolsMap = new Map(
        options.connection.tools.map((tool) => [tool.name, tool]),
      );
    }
  }

  private async ensureToolsMap(): Promise<Map<string, any>> {
    if (this.cachedToolsMap) return this.cachedToolsMap;
    if (!this.toolsMapPromise) {
      this.toolsMapPromise = (async () => {
        const cache = this.options.cache ?? getMcpListCache();
        if (cache) {
          const tools = await cache.get("tools", this.options.connection.id);
          if (tools) {
            this.cachedToolsMap = new Map(
              (tools as Array<{ name: string }>).map((t) => [t.name, t]),
            );
            return this.cachedToolsMap;
          }
        }
        return new Map();
      })();
    }
    return this.toolsMapPromise;
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
