/**
 * Virtual MCP Collection Hooks
 *
 * Provides React hooks for working with virtual MCPs using React Query.
 * These hooks offer a reactive interface for accessing and manipulating virtual MCPs.
 */

import { useQuery } from "@tanstack/react-query";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
import { SELF_MCP_ALIAS_ID } from "../lib/constants";
import { KEYS } from "../lib/query-keys";

export interface VirtualMCPLastUsed {
  id: string;
  last_used_at?: string;
  last_used_by?: string;
}

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
    orgSlug: org.slug,
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
    orgSlug: org.slug,
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
 * Hook to fetch last-used info (most recent thread timestamp + user) for a set
 * of virtual MCPs. Backed by VIRTUAL_MCP_LAST_USED_LIST so the data isn't
 * loaded on the agent fetch hot path.
 */
export function useVirtualMCPsLastUsed(ids: string[]) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const sortedIds = [...ids].sort();

  return useQuery<Map<string, VirtualMCPLastUsed>>({
    queryKey: KEYS.virtualMcpLastUsed(org.id, sortedIds),
    enabled: sortedIds.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const result = (await client.callTool({
        name: "VIRTUAL_MCP_LAST_USED_LIST",
        arguments: { ids: sortedIds },
      })) as CallToolResult;
      const payload = (result.structuredContent ?? { items: [] }) as {
        items: VirtualMCPLastUsed[];
      };
      const map = new Map<string, VirtualMCPLastUsed>();
      for (const item of payload.items) map.set(item.id, item);
      return map;
    },
  });
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
    orgSlug: org.slug,
  });

  return useCollectionActions<VirtualMCPEntity>(org.id, "VIRTUAL_MCP", client);
}
