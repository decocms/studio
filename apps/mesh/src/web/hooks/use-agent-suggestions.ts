import { useProjectContext } from "@decocms/mesh-sdk";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "../lib/query-keys";

export function useAgentSuggestions(
  virtualMcpId: string | null | undefined,
): string[] {
  const { org } = useProjectContext();
  const id = virtualMcpId ?? null;

  const { data } = useQuery({
    queryKey: KEYS.agentSuggestions(org.id, id),
    enabled: !!id,
    staleTime: Infinity,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    queryFn: async (): Promise<string[]> => {
      const response = await fetch(
        `/api/${org.slug}/decopilot/agent-suggestions`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ virtualMcpId: id }),
        },
      );
      if (!response.ok) return [];
      const json = (await response.json()) as { suggestions?: string[] };
      return Array.isArray(json.suggestions) ? json.suggestions : [];
    },
  });

  return data ?? [];
}
