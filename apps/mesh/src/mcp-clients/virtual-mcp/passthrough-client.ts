/**
 * PassthroughClient
 *
 * Extends GatewayClient with mesh-specific concerns: connection metadata
 * enrichment on tools and VirtualMCP instructions.
 */

import {
  GatewayClient,
  type ClientEntry,
  getGatewayClientId,
  stripToolNamespace,
} from "@decocms/mcp-utils/aggregate";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ListPromptsRequest,
  ListPromptsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { MeshContext } from "../../core/mesh-context";
import {
  findStudioPackAgentByMcpId,
  resolveStudioPackChecklist,
} from "../../tools/virtual/studio-pack";
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

  /**
   * Studio Pack agents back their welcome-screen icebreakers with onboarding
   * prompts (e.g. Brand Manager's "Set up your brand"). Each prompt mirrors a
   * checklist item whose `isCompleted` reflects org state. Once an item is
   * done, its prompt should stop being suggested — same logic the home
   * next-actions route already applies. Filter completed items out here so the
   * icebreakers, tools popover, and harness prompt block all stay in sync.
   * Non-studio-pack agents are untouched.
   */
  override async listPrompts(
    params?: ListPromptsRequest["params"],
    options?: RequestOptions,
  ): Promise<ListPromptsResult> {
    const result = await super.listPrompts(params, options);

    const agent = findStudioPackAgentByMcpId(this.options.virtualMcp.id ?? "");
    const orgId = this.ctx.organization?.id;
    if (!agent || !orgId) return result;

    const items = await resolveStudioPackChecklist(agent, {
      orgId,
      ctx: this.ctx,
    });
    const completed = new Set(
      items
        .filter(
          (item) =>
            item.completed &&
            !item.alwaysSuggest &&
            item.action.kind === "open-agent-thread",
        )
        .map((item) => (item.action as { promptName: string }).promptName),
    );
    if (completed.size === 0) return result;

    return {
      ...result,
      prompts: result.prompts.filter(
        (prompt) =>
          !completed.has(
            stripToolNamespace(prompt.name, getGatewayClientId(prompt._meta)),
          ),
      ),
    };
  }

  override getInstructions(): string | undefined {
    return this.options.virtualMcp.metadata?.instructions ?? undefined;
  }

  getConnectionTitleMap(): Map<string, string> {
    return new Map(this.options.connections.map((c) => [c.id, c.title]));
  }
}
