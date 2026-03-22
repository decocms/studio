import { useVirtualMCPs, type UseVirtualMCPsOptions } from "@decocms/mesh-sdk";

/**
 * Hook to fetch only agent virtual MCPs (subtype = "agent").
 * Mirrors the useProjects() pattern for project-scoped data.
 */
export function useAgents(options: UseVirtualMCPsOptions = {}) {
  return useVirtualMCPs({
    ...options,
    filters: [
      ...(options.filters ?? []),
      { column: "subtype", value: "agent" },
    ],
  });
}
