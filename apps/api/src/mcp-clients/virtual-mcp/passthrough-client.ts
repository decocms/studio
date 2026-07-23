/**
 * PassthroughClient
 *
 * Extends GatewayClient with Studio-specific concerns: connection metadata
 * enrichment on tools and VirtualMCP instructions.
 */

import {
  GatewayClient,
  type ClientEntry,
  getGatewayClientId,
  slugify,
  stripToolNamespace,
} from "@decocms/mcp-utils/aggregate";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  GetPromptRequest,
  GetPromptResult,
  ListPromptsRequest,
  ListPromptsResult,
  Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import type { StudioContext } from "../../core/studio-context";
import {
  readAgentPrompts,
  type StoredAgentPrompt,
} from "../../file-storage/agent-prompts";
import {
  findStudioPackAgentByMcpId,
  resolveStudioPackChecklist,
} from "../../tools/virtual/studio-pack";
import { createLazyClient } from "../lazy-client";
import { withKnowledge } from "./knowledge";
import type { VirtualClientOptions } from "./types";

/**
 * Aggregates MCP resources from multiple connections via GatewayClient.
 * Tool/prompt names are namespaced with slugified connection IDs.
 */
export class PassthroughClient extends GatewayClient {
  /** Cached org-fs read of this agent's seeded kickstart prompts. */
  private agentPromptsCache: Promise<StoredAgentPrompt[]> | null = null;

  constructor(
    protected options: VirtualClientOptions,
    protected ctx: StudioContext,
  ) {
    // Build VirtualMCP connection lookup for per-client selection
    const vmcpConnMap = new Map(
      (options.virtualMcp?.connections ?? []).map((c) => [c.connection_id, c]),
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
    const base = await super.listPrompts(params, options);
    const seeded = await this.listSeededPrompts();
    const result: ListPromptsResult = {
      ...base,
      prompts: [...base.prompts, ...seeded],
    };

    const agent = findStudioPackAgentByMcpId(this.options.virtualMcp?.id ?? "");
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

  /**
   * Resolve a kickstart prompt seeded on THIS agent (stored in org-fs) before
   * delegating to the aggregator. Seeded prompts have no owning child
   * connection, so the gateway's namespace routing would 404 them.
   */
  override async getPrompt(
    params: GetPromptRequest["params"],
    options?: RequestOptions,
  ): Promise<GetPromptResult> {
    const agentId = this.options.virtualMcp?.id;
    if (agentId) {
      const prefix = `${slugify(agentId)}_`;
      if (params.name.startsWith(prefix)) {
        const localName = params.name.slice(prefix.length);
        const stored = await this.loadSeededPrompts();
        const match = stored.find((p) => p.name === localName);
        if (match) {
          return {
            description: match.description,
            messages: [
              { role: "user", content: { type: "text", text: match.text } },
            ],
          };
        }
      }
    }
    return super.getPrompt(params, options);
  }

  /**
   * The agent's own kickstart prompts (org-fs), shaped as gateway prompts:
   * namespaced under the agent id so the icebreaker chip's strip/resolve flow
   * lines up with `getPrompt` above. Cached per instance. Never throws.
   */
  private async listSeededPrompts(): Promise<Prompt[]> {
    const agentId = this.options.virtualMcp?.id;
    if (!agentId) return [];
    const stored = await this.loadSeededPrompts();
    const prefix = slugify(agentId);
    return stored.map((p) => ({
      name: `${prefix}_${p.name}`,
      title: p.title,
      description: p.description,
      _meta: { gatewayClientId: agentId },
    }));
  }

  /** Cached org-fs read of the agent's seeded prompts. Never throws. */
  private loadSeededPrompts(): Promise<StoredAgentPrompt[]> {
    const agentId = this.options.virtualMcp?.id;
    const orgFs = this.ctx.orgFs;
    if (!agentId || !orgFs) return Promise.resolve([]);
    if (!this.agentPromptsCache) {
      this.agentPromptsCache = readAgentPrompts(orgFs, agentId);
    }
    return this.agentPromptsCache;
  }

  override getInstructions(): string | undefined {
    // Fold the agent's attached files/skills into its served instructions so
    // they reach the model on every run path (cluster engine AND sandbox
    // daemon both read instructions; only the cluster runs the richer
    // buildAgentSystemPrompt).
    const base = this.options.virtualMcp
      ? withKnowledge(
          this.options.virtualMcp.metadata?.instructions ?? undefined,
          this.options.virtualMcp.metadata?.knowledge,
        )
      : this.options.instructions;
    // Append the pre-rendered <available-skills> catalog (built async in the
    // factory). Same seam, same both-paths guarantee as the knowledge block.
    const skills = this.options.skillsBlock;
    if (!skills) return base;
    return base ? `${base}${skills}` : skills.replace(/^\n+/, "");
  }

  getConnectionTitleMap(): Map<string, string> {
    return new Map(this.options.connections.map((c) => [c.id, c.title]));
  }
}
