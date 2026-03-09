/**
 * Virtual MCP Collection Hooks
 *
 * Provides React hooks for working with virtual MCPs using React Query.
 * These hooks offer a reactive interface for accessing and manipulating virtual MCPs.
 */

import type { VirtualMCPEntity } from "../types/virtual-mcp";
import { useProjectContext } from "../context";
import {
  useCollectionActions,
  useCollectionItem,
  useCollectionList,
  type CollectionFilter,
  type UseCollectionListOptions,
} from "./use-collections";
import { useMCPClient } from "./use-mcp-client";
import { useMCPToolCallQuery } from "./use-mcp-tools";
import { SELF_MCP_ALIAS_ID } from "../lib/constants";

/**
 * Filter definition for virtual MCPs (matches @deco/ui Filter shape)
 */
export type VirtualMCPFilter = CollectionFilter;

/**
 * Options for useVirtualMCPs hook
 */
export type UseVirtualMCPsOptions = UseCollectionListOptions<VirtualMCPEntity>;

/**
 * Hook to get all virtual MCPs
 *
 * @param options - Filter and configuration options
 * @returns Suspense query result with virtual MCPs as VirtualMCPEntity[]
 */
export function useVirtualMCPs(options: UseVirtualMCPsOptions = {}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  return useCollectionList<VirtualMCPEntity>(
    org.id,
    "VIRTUAL_MCP",
    client,
    options,
  );
}

/**
 * Hook to get a single virtual MCP by ID
 *
 * @param virtualMcpId - The ID of the virtual MCP to fetch (null/undefined for default virtual MCP)
 * @returns VirtualMCPEntity | null - null means use default virtual MCP
 */
export function useVirtualMCP(
  virtualMcpId: string | null | undefined,
): VirtualMCPEntity | null {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  // If null/undefined, return null (use default virtual MCP)
  // Use collection item hook for database virtual MCPs
  const dbVirtualMCP = useCollectionItem<VirtualMCPEntity>(
    org.id,
    "VIRTUAL_MCP",
    virtualMcpId ?? undefined,
    client,
  );

  return dbVirtualMCP;
}

/**
 * Hook to get virtual MCP mutation actions (create, update, delete)
 *
 * @returns Object with create, update, and delete mutation hooks
 */
export function useVirtualMCPActions() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  return useCollectionActions<VirtualMCPEntity>(org.id, "VIRTUAL_MCP", client);
}

interface AgentLastUsedResult {
  lastUsed: Record<string, string>;
}

/**
 * Hook to get last usage timestamps for agents.
 * Returns a map of virtualMcpId -> ISO timestamp. Missing keys mean never used.
 *
 * @param virtualMcpIds - IDs of the agents to check
 * @returns Record of virtualMcpId to last used timestamp
 */
export function useAgentLastUsed(
  virtualMcpIds: string[],
): Record<string, string> {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  // Sort IDs for stable query key (JSON.stringify order matters for cache)
  const sortedIds = [...virtualMcpIds].sort();

  const { data } = useMCPToolCallQuery<AgentLastUsedResult>({
    client,
    toolName: "MONITORING_AGENT_LAST_USED",
    toolArguments: { virtualMcpIds: sortedIds },
    enabled: sortedIds.length > 0,
    staleTime: 60_000,
    select: (result) =>
      ((result as { structuredContent?: unknown }).structuredContent ??
        result) as AgentLastUsedResult,
  });

  return data?.lastUsed ?? {};
}
