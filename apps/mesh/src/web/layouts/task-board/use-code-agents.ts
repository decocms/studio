import {
  isDecopilot,
  isStudioPackAgent,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import {
  agentHasClonableSource,
  getDevAgentIds,
} from "@/web/lib/agent-capabilities";

/**
 * The org's "code agents" — Virtual MCPs backed by a clonable GitHub repo,
 * assignable to a task (assigning delegates a run to that agent, like the Super
 * Agent). Mirrors the sidebar's Code Agents grouping (`agents-section.tsx`):
 * excludes Decopilot (the Super Agent, listed separately), dev-only agents, and
 * Studio Pack defaults, then keeps only repo-backed agents.
 */
export function useCodeAgents(): VirtualMCPEntity[] {
  const all = useVirtualMCPs() ?? [];
  const devAgentIds = getDevAgentIds(all);
  return all.filter(
    (a) =>
      !isDecopilot(a.id) &&
      !devAgentIds.has(a.id) &&
      !isStudioPackAgent(a.id) &&
      agentHasClonableSource(a.metadata),
  );
}
