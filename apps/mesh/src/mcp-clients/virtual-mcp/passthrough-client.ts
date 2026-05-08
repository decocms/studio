/**
 * PassthroughClient
 *
 * Extends GatewayClient with mesh-specific concerns: connection metadata
 * enrichment on tools and VirtualMCP instructions.
 */

import { GatewayClient, type ClientEntry } from "@decocms/mcp-utils/aggregate";
import type { MeshContext } from "../../core/mesh-context";
import { createLazyClient } from "../lazy-client";
import type { VirtualClientOptions } from "./types";

/**
 * Aggregates MCP resources from multiple connections via GatewayClient.
 * Tool/prompt names are namespaced with slugified connection IDs.
 */
export class PassthroughClient extends GatewayClient {
  constructor(
    protected options: VirtualClientOptions,
    protected ctx: MeshContext,
  ) {
    // Build VirtualMCP connection lookup for per-client selection
    const vmcpConnMap = new Map(
      options.virtualMcp.connections.map((c) => [c.connection_id, c]),
    );

    // Build ClientEntry record
    const clients: Record<string, ClientEntry> = {};

    for (const connection of options.connections) {
      const vmcpConn = vmcpConnMap.get(connection.id);

      clients[connection.id] = {
        client: () =>
          createLazyClient(
            connection,
            ctx,
            options.superUser ?? false,
            options.mcpListCache,
          ),
        ...(vmcpConn?.selected_tools != null
          ? { tools: vmcpConn.selected_tools }
          : {}),
        ...(vmcpConn?.selected_resources != null
          ? { resources: vmcpConn.selected_resources }
          : {}),
        ...(vmcpConn?.selected_prompts != null
          ? { prompts: vmcpConn.selected_prompts }
          : {}),
      };
    }

    super(clients, {
      clientInfo: { name: "virtual-mcp-passthrough", version: "1.0.0" },
      capabilities: {
        tasks: {
          list: {},
          cancel: {},
          requests: {
            tool: {
              call: {},
            },
          },
        },
      },
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  override getInstructions(): string | undefined {
    return this.options.virtualMcp.metadata?.instructions ?? undefined;
  }

  getConnectionTitleMap(): Map<string, string> {
    return new Map(this.options.connections.map((c) => [c.id, c.title]));
  }
}
