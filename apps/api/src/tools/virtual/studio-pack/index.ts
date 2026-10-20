import {
  RETIRED_STUDIO_PACK_AGENT_ID_PREFIXES,
  WellKnownOrgMCPId,
} from "@decocms/shared/sdk";
import type { VirtualMCPStorage } from "@/storage/virtual";
import type { VirtualMCPEntity } from "../schema";
import { apiKeyManagerAgent } from "./api-key-manager";
import { automationManagerAgent } from "./automation-manager";
import { connectionManagerAgent } from "./connection-manager";
import { storeManagerAgent } from "./store-manager";
import { usageManagerAgent } from "./usage-manager";
import type {
  ChecklistContext,
  ResolvedChecklistItem,
  StudioPackChecklistItem,
  StudioPackConnectionKey,
} from "./types";

export type {
  ChecklistContext,
  ChecklistItemAction,
  ResolvedChecklistItem,
  StudioPackChecklistItem,
} from "./types";

/**
 * Studio Pack agents that used to be installed and no longer are. Their rows
 * are deleted on the next backfill so the retired manager stops showing up on
 * the org's agents page. Deleting a virtual MCP also deletes its threads —
 * intentional here: these are system-managed board-management chats.
 */
const RETIRED_AGENT_ID_PREFIXES = RETIRED_STUDIO_PACK_AGENT_ID_PREFIXES;

export const STUDIO_PACK_AGENTS = [
  automationManagerAgent,
  connectionManagerAgent,
  apiKeyManagerAgent,
  storeManagerAgent,
  usageManagerAgent,
] as const;

type StudioPackAgent = (typeof STUDIO_PACK_AGENTS)[number];

export function findStudioPackAgentByMcpId(
  virtualMcpId: string,
): StudioPackAgent | null {
  return (
    STUDIO_PACK_AGENTS.find((a) => virtualMcpId.startsWith(`${a.id}_`)) ?? null
  );
}

/**
 * Apply the code-owned runtime configuration for a Studio Pack agent.
 * Persisted rows can lag behind the current definition until the startup
 * override runs, so every execution path resolves through this helper.
 */
export function resolveEffectiveStudioPackVirtualMcp(
  virtualMcp: VirtualMCPEntity,
  agentId: string = virtualMcp.id,
): VirtualMCPEntity {
  const studioPackAgent = findStudioPackAgentByMcpId(agentId);
  if (!studioPackAgent) return virtualMcp;

  const selectedTools = studioPackAgent.selectedTools
    ? [...studioPackAgent.selectedTools]
    : null;

  return {
    ...virtualMcp,
    metadata: {
      ...((virtualMcp.metadata as Record<string, unknown>) ?? {}),
      instructions: studioPackAgent.instructions,
    },
    connections: virtualMcp.connections.map((connection) => ({
      ...connection,
      selected_tools: selectedTools,
    })),
  };
}

export async function resolveStudioPackChecklist(
  agent: StudioPackAgent,
  c: ChecklistContext,
): Promise<ResolvedChecklistItem[]> {
  if (!("checklist" in agent)) return [];
  return Promise.all(
    agent.checklist.map(async (item: StudioPackChecklistItem) => ({
      label: item.label,
      activeForm: item.activeForm,
      action: item.action,
      completed: await item.isCompleted(c),
      alwaysSuggest: item.alwaysSuggest,
    })),
  );
}

export async function installStudioPack(
  orgId: string,
  createdBy: string,
  virtualMcpStorage: VirtualMCPStorage,
): Promise<void> {
  const connectionForKey: Record<StudioPackConnectionKey, string> = {
    self: WellKnownOrgMCPId.SELF(orgId),
  };

  await Promise.all(
    RETIRED_AGENT_ID_PREFIXES.map((prefix) =>
      virtualMcpStorage.delete(`${prefix}${orgId}`),
    ),
  );

  await Promise.all(
    STUDIO_PACK_AGENTS.map(async (agent) => {
      const agentId = agent.getId(orgId);

      // Startup backfills install missing managers. Existing Studio Pack
      // agents are system-managed, so overwrite their connection and tool
      // selections with the current code-owned definition.
      const existing = await virtualMcpStorage.findById(agentId, orgId);
      const connectionKeys = agent.selectedConnections ?? ["self"];
      const connectionIds = connectionKeys.map((k) => connectionForKey[k]);

      if (existing) {
        await virtualMcpStorage.update(agentId, createdBy, {
          metadata: {
            ...((existing.metadata as Record<string, unknown>) ?? {}),
            instructions: agent.instructions,
          },
          connections: connectionIds.map((connection_id) => {
            const current = existing.connections.find(
              (connection) => connection.connection_id === connection_id,
            );
            return {
              connection_id,
              selected_tools: agent.selectedTools
                ? [...agent.selectedTools]
                : null,
              selected_resources: current?.selected_resources ?? null,
              selected_prompts: current?.selected_prompts ?? null,
            };
          }),
        });
        return;
      }

      await virtualMcpStorage.create(
        orgId,
        createdBy,
        {
          title: agent.title,
          description: agent.description,
          icon: agent.icon,
          status: "active",
          pinned: false,
          metadata: {
            instructions: agent.instructions,
          },
          connections: connectionIds.map((connection_id) => ({
            connection_id,
            selected_tools: agent.selectedTools
              ? [...agent.selectedTools]
              : null,
            selected_resources: null,
            // An empty array means "no prompts" (correct for agents without
            // onboarding items). `null` would mean "all prompts allowed".
            selected_prompts: agent.selectedPrompts
              ? [...agent.selectedPrompts]
              : null,
          })),
        },
        { id: agentId },
      );
    }),
  );
}
