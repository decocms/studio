import { useVirtualMCPs, type UseVirtualMCPsOptions } from "@decocms/mesh-sdk";

/**
 * Hook to fetch only project virtual MCPs (subtype = "project").
 * Mirrors the useAgents() pattern for agent-scoped data.
 */
export function useProjects(options: UseVirtualMCPsOptions = {}) {
  return useVirtualMCPs({
    ...options,
    filters: [
      ...(options.filters ?? []),
      { column: "subtype", value: "project" },
    ],
  });
}
