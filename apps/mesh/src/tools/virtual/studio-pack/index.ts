import { WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import type { VirtualMCPStorage } from "@/storage/virtual";
import { agentManagerAgent } from "./agent-manager";
import { automationManagerAgent } from "./automation-manager";
import { brandManagerAgent } from "./brand-manager";
import { connectionManagerAgent } from "./connection-manager";
import { storeManagerAgent } from "./store-manager";
import type {
  ChecklistContext,
  ResolvedChecklistItem,
  ResolvedRuntime,
  RuntimeResolveContext,
  StudioPackConnectionKey,
} from "./types";

export {
  resolveStorefrontManagerChecklist,
  storefrontManagerAgent,
} from "./storefront-manager";
export type {
  BuildWelcomeMessage,
  ChecklistContext,
  ChecklistItemAction,
  ResolvedChecklistItem,
  ResolvedRuntime,
  ResolveRuntime,
  RuntimeResolveContext,
  StudioPackChecklistItem,
  WelcomeContext,
} from "./types";

export const STUDIO_PACK_AGENTS = [
  brandManagerAgent,
  agentManagerAgent,
  automationManagerAgent,
  connectionManagerAgent,
  storeManagerAgent,
] as const;

type StudioPackAgent = (typeof STUDIO_PACK_AGENTS)[number];

export function findStudioPackAgentByMcpId(
  virtualMcpId: string,
): StudioPackAgent | null {
  return (
    STUDIO_PACK_AGENTS.find((a) => virtualMcpId.startsWith(`${a.id}_`)) ?? null
  );
}

export async function resolveStudioPackRuntime(
  agent: StudioPackAgent,
  rt: RuntimeResolveContext,
): Promise<ResolvedRuntime> {
  if ("resolveRuntime" in agent) {
    return agent.resolveRuntime(rt);
  }
  return {
    instructions: agent.instructions,
    selectedTools: agent.selectedTools,
  };
}

export async function resolveStudioPackChecklist(
  agent: StudioPackAgent,
  c: ChecklistContext,
): Promise<ResolvedChecklistItem[]> {
  if (!("checklist" in agent)) return [];
  return Promise.all(
    agent.checklist.map(async (item) => ({
      label: item.label,
      activeForm: item.activeForm,
      action: item.action,
      completed: await item.isCompleted(c),
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
    registry: WellKnownOrgMCPId.REGISTRY(orgId),
    "community-registry": WellKnownOrgMCPId.COMMUNITY_REGISTRY(orgId),
  };

  await Promise.all(
    STUDIO_PACK_AGENTS.map(async (agent) => {
      const agentId = agent.getId(orgId);

      // Idempotent: skip if this agent already exists in the org. Existing
      // orgs pre-dating Store Manager already have the other three; we only
      // backfill what's missing.
      const existing = await virtualMcpStorage.findById(agentId, orgId);
      if (existing) return;

      const connectionKeys = agent.selectedConnections ?? ["self"];
      const connectionIds = connectionKeys.map((k) => connectionForKey[k]);

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
            selected_prompts: null,
          })),
        },
        { id: agentId },
      );
    }),
  );
}
