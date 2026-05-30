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
