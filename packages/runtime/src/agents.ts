import { proxyConnectionForId } from "./bindings.ts";
import { MCPClient } from "./mcp.ts";

/**
 * Declarative agent creation for MCP servers.
 *
 * An "agent" in Studio is a Virtual MCP (a curated bundle of connections +
 * tools, optionally with instructions). `createAgent` is typed sugar over the
 * studio self-endpoint tools COLLECTION_VIRTUAL_MCP_CREATE + AUTOMATION_CREATE +
 * AUTOMATION_TRIGGER_ADD via the self-client pattern.
 *
 * Exposed to MCP authors through `configuration.onInstall`, which fires once on
 * the first ON_MCP_CONFIGURATION call (first config save) for a connection.
 */

/** Model tier presets resolved per-org. Mirrors the server `ChatTierSchema`. */
export type AgentModelTier = "fast" | "smart" | "thinking";

export interface AgentModels {
  tier: AgentModelTier;
  /** Pin a concrete model instead of resolving the org tier preset. */
  modelId?: string;
  credentialId?: string;
}

/** A chat message for an automation's seed thread. */
export interface AutomationMessage {
  id?: string;
  role: "user" | "assistant" | "system";
  parts: Array<Record<string, unknown>>;
  metadata?: unknown;
}

/** Friendly trigger shape, mapped onto AUTOMATION_TRIGGER_ADD's fields. */
export type AutomationTrigger =
  | { type: "cron"; cron: string }
  | {
      type: "event";
      connectionId: string;
      eventType: string;
      params?: Record<string, string>;
    }
  | { type: "webhook" };

export interface CreateAgentAutomation {
  name: string;
  messages: string | AutomationMessage[];
  models?: AgentModels;
  /** Allowlist of model-facing tool names. null/omitted = all bound tools. */
  tools?: string[] | null;
  triggers?: AutomationTrigger[];
  active?: boolean;
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  instructions?: string;
  /**
   * Connections (and their tool subsets) the agent exposes. Omit to bind the
   * installing connection itself with all of its tools.
   */
  tools?: Array<{ connectionId: string; tools?: string[] | null }>;
  automations?: CreateAgentAutomation[];
}

/** Outcome of a single AUTOMATION_TRIGGER_ADD call (never throws the caller out). */
export interface TriggerResult {
  type: AutomationTrigger["type"];
  ok: boolean;
  id?: string;
  /** Set when `ok` is false — e.g. an event trigger the target connection rejected. */
  error?: string;
  /** Present only for a successful webhook trigger; the token is shown only here. */
  webhook?: { url: string; token: string };
}

export interface CreatedAutomation {
  id: string;
  name: string;
  triggers: TriggerResult[];
}

export interface CreateAgentResult {
  id: string;
  automations: CreatedAutomation[];
  /** Convenience: ids of created automations (empty on a no-op re-install). */
  automationIds: string[];
  /** True when an agent with this title already existed (no-op re-install). */
  alreadyExisted: boolean;
}

export interface StudioVaultBootstrap {
  baseUrl: string;
  org: string;
  subjectConnectionId: string;
  token: string;
}

export interface InstallContext {
  createAgent: (input: CreateAgentInput) => Promise<CreateAgentResult>;
  vault?: StudioVaultBootstrap;
}

interface VirtualMcpItem {
  id: string;
  title: string;
}

/**
 * Hand-rolled client for the studio self-endpoint tools used by createAgent.
 *
 * TODO: Replace with a generated client once these collection/automation tools
 * are covered by a binding. Until then, a rename of a tool or field on the
 * server requires a matching change here.
 */
interface MeshAgentClient {
  COLLECTION_VIRTUAL_MCP_LIST: (input: {
    where?: {
      operator: "and";
      conditions: Array<{ field: string[]; operator: string; value: unknown }>;
    };
    limit?: number;
    offset?: number;
  }) => Promise<{
    items: VirtualMcpItem[];
    totalCount: number;
    hasMore: boolean;
  }>;
  COLLECTION_VIRTUAL_MCP_CREATE: (input: {
    data: {
      title: string;
      description?: string;
      metadata?: { instructions?: string };
      connections: Array<{
        connection_id: string;
        selected_tools: string[] | null;
        selected_resources: string[] | null;
        selected_prompts: string[] | null;
      }>;
    };
  }) => Promise<{ item: VirtualMcpItem }>;
  AUTOMATION_CREATE: (input: {
    name: string;
    virtual_mcp_id: string;
    messages: string | AutomationMessage[];
    models?: AgentModels;
    tools?: string[] | null;
    active?: boolean;
  }) => Promise<{ id: string }>;
  AUTOMATION_TRIGGER_ADD: (input: {
    automation_id: string;
    type: "cron" | "event" | "webhook";
    cron_expression?: string;
    connection_id?: string;
    event_type?: string;
    params?: Record<string, string>;
  }) => Promise<{
    id: string;
    webhook?: { url: string; token: string } | null;
  }>;
}

function createMeshSelfClient(
  meshUrl: string,
  token?: string,
): MeshAgentClient {
  const connection = proxyConnectionForId("self", { meshUrl, token });
  return MCPClient.forConnection(connection) as unknown as MeshAgentClient;
}

/**
 * Scopes a connection must declare in `configuration.scopes` to use
 * `createAgent` from `onInstall`. Co-located so a server-side tool rename
 * surfaces as a compile error in the consumer rather than a silent 403.
 */
export const AGENT_SCOPES = [
  "SELF::COLLECTION_VIRTUAL_MCP_LIST",
  "SELF::COLLECTION_VIRTUAL_MCP_CREATE",
  "SELF::AUTOMATION_CREATE",
  "SELF::AUTOMATION_TRIGGER_ADD",
] as const;

function triggerArgs(automationId: string, trigger: AutomationTrigger) {
  switch (trigger.type) {
    case "cron":
      return {
        automation_id: automationId,
        type: "cron" as const,
        cron_expression: trigger.cron,
      };
    case "event":
      return {
        automation_id: automationId,
        type: "event" as const,
        connection_id: trigger.connectionId,
        event_type: trigger.eventType,
        params: trigger.params,
      };
    case "webhook":
      return { automation_id: automationId, type: "webhook" as const };
  }
}

/**
 * Builds the `createAgent` helper bound to a studio self-endpoint.
 *
 * Idempotent by title: if a Virtual MCP with the same title already exists, the
 * call is a no-op that returns the existing id. This keeps a cleared-then-
 * resaved config (which re-fires onInstall) from minting duplicates.
 */
export function makeCreateAgent(
  meshUrl: string | undefined,
  token: string | undefined,
  connectionId: string | undefined,
): (input: CreateAgentInput) => Promise<CreateAgentResult> {
  return async (input) => {
    if (!meshUrl) {
      throw new Error("createAgent: missing meshUrl in MESH_REQUEST_CONTEXT");
    }
    const self = createMeshSelfClient(meshUrl, token);

    const existing = await self.COLLECTION_VIRTUAL_MCP_LIST({
      where: {
        operator: "and",
        conditions: [{ field: ["title"], operator: "eq", value: input.name }],
      },
      limit: 1,
    });
    const match = existing.items.find((i) => i.title === input.name);
    if (match) {
      return {
        id: match.id,
        automations: [],
        automationIds: [],
        alreadyExisted: true,
      };
    }

    const connections =
      input.tools && input.tools.length > 0
        ? input.tools.map((t) => ({
            connection_id: t.connectionId,
            selected_tools: t.tools ?? null,
            selected_resources: null,
            selected_prompts: null,
          }))
        : connectionId
          ? [
              {
                connection_id: connectionId,
                selected_tools: null,
                selected_resources: null,
                selected_prompts: null,
              },
            ]
          : [];

    const { item } = await self.COLLECTION_VIRTUAL_MCP_CREATE({
      data: {
        title: input.name,
        description: input.description,
        metadata: input.instructions
          ? { instructions: input.instructions }
          : undefined,
        connections,
      },
    });

    const automations: CreatedAutomation[] = [];
    for (const automation of input.automations ?? []) {
      const created = await self.AUTOMATION_CREATE({
        name: automation.name,
        virtual_mcp_id: item.id,
        messages: automation.messages,
        models: automation.models,
        tools: automation.tools,
        active: automation.active ?? true,
      });
      // Per-trigger isolation: a rejected trigger (e.g. an event trigger the
      // target connection can't configure) is recorded, not thrown — the agent
      // and its other triggers still land.
      const triggers: TriggerResult[] = [];
      for (const trigger of automation.triggers ?? []) {
        try {
          const res = await self.AUTOMATION_TRIGGER_ADD(
            triggerArgs(created.id, trigger),
          );
          triggers.push({
            type: trigger.type,
            ok: true,
            id: res.id,
            webhook: res.webhook ?? undefined,
          });
        } catch (err) {
          triggers.push({
            type: trigger.type,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      automations.push({ id: created.id, name: automation.name, triggers });
    }

    return {
      id: item.id,
      automations,
      automationIds: automations.map((a) => a.id),
      alreadyExisted: false,
    };
  };
}
