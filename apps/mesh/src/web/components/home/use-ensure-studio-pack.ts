import {
  WellKnownOrgMCPId,
  useProjectContext,
  useVirtualMCPActions,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import { STUDIO_PACK_AGENTS } from "@/tools/virtual/studio-pack";

/**
 * Returns an `ensure` function that idempotently installs the Studio Pack
 * agents identified by their template ids (e.g. "studio-agent-manager").
 * Existing agents (matched by title — same heuristic as the recruit modal)
 * are skipped. Resolves once every requested template is present.
 */
export function useEnsureStudioPack() {
  const { org } = useProjectContext();
  const actions = useVirtualMCPActions();
  const existingAgents = useVirtualMCPs();

  return async function ensure(
    templateIds: ReadonlyArray<(typeof STUDIO_PACK_AGENTS)[number]["id"]>,
  ): Promise<void> {
    const selfConnectionId = WellKnownOrgMCPId.SELF(org.id);
    const existingTitles = new Set(existingAgents.map((a) => a.title));

    const targets = STUDIO_PACK_AGENTS.filter((a) =>
      templateIds.includes(a.id),
    );

    for (const agent of targets) {
      if (existingTitles.has(agent.title)) continue;
      await actions.create.mutateAsync({
        title: agent.title,
        description: agent.description,
        icon: agent.icon,
        status: "active",
        metadata: { instructions: agent.instructions },
        connections: [
          {
            connection_id: selfConnectionId,
            selected_tools: [...agent.selectedTools],
            selected_resources: null,
            selected_prompts: null,
          },
        ],
      });
    }
  };
}

export type EnsureStudioPack = ReturnType<typeof useEnsureStudioPack>;
