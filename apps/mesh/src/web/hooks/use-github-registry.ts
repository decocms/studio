/**
 * React Query hooks for fetching skill/agent items from a GitHub registry.
 * Calls the SKILL_REGISTRY_* MCP tools via the self MCP client.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { KEYS } from "../lib/query-keys";
import type { RegistryItem } from "../components/store/types";

function extractResult<T>(result: unknown): T {
  const r = result as { structuredContent?: T };
  return (r.structuredContent ?? result) as T;
}

export function useGitHubRegistry(owner: string, repo: string) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  return useQuery({
    queryKey: KEYS.skillRegistryList(owner, repo),
    queryFn: async () => {
      const result = await client.callTool({
        name: "SKILL_REGISTRY_LIST",
        arguments: { owner, repo, type: "all" },
      });
      const data = extractResult<{
        items: RegistryItem[];
        total: number;
      }>(result);
      return data;
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!owner && !!repo,
  });
}

export function useGitHubRegistryItem(
  owner: string,
  repo: string,
  type: "skill" | "agent",
  name: string,
) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  return useQuery({
    queryKey: KEYS.skillRegistryItem(owner, repo, type, name),
    queryFn: async () => {
      const result = await client.callTool({
        name: "SKILL_REGISTRY_GET",
        arguments: { owner, repo, type, name },
      });
      return extractResult<{
        type: "skill" | "agent";
        name: string;
        description: string;
        body: string;
        rawContent: string;
        icon?: string;
        skills?: string[];
        instructions?: string;
        disableModelInvocation?: boolean;
      }>(result);
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!owner && !!repo && !!name,
  });
}

export function useGitHubRegistrySync() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ owner, repo }: { owner: string; repo: string }) => {
      const result = await client.callTool({
        name: "SKILL_REGISTRY_SYNC",
        arguments: { owner, repo },
      });
      return extractResult<{
        path: string;
        status: "cloned" | "updated" | "unchanged";
      }>(result);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: KEYS.skillRegistryList(variables.owner, variables.repo),
      });
    },
  });
}
