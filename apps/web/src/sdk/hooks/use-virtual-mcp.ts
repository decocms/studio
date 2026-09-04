/**
 * Virtual MCP Collection Hooks
 *
 * Provides React hooks for working with virtual MCPs using React Query.
 * These hooks offer a reactive interface for accessing and manipulating virtual MCPs.
 */

import { type QueryClient, useQuery } from "@tanstack/react-query";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types/virtual-mcp";
import { useProjectContext } from "../context";
import {
  collectionListPageQueryOptions,
  collectionItemQueryOptions,
  collectionListQueryOptions,
  useCollectionActions,
  useCollectionItem,
  useCollectionList,
  type CollectionFilter,
  type UseCollectionListOptions,
} from "./use-collections";
import {
  mcpClientQueryOptions,
  useMCPClient,
  useMCPClientNonBlocking,
} from "./use-mcp-client";
import { SELF_MCP_ALIAS_ID } from "@decocms/shared/sdk/lib/constants";
import { KEYS } from "@/lib/query-keys";

export interface VirtualMCPLastUsed {
  id: string;
  last_used_at?: string;
  last_used_by?: string;
}

/**
 * Filter definition for virtual MCPs (matches @decocms/ui Filter shape)
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
 * The org's virtual MCPs, read WITHOUT suspending — `[]` until it resolves and
 * `[]` on failure.
 *
 * The sidebar's scope chip is gated on how many projects the org has, and the
 * sidebar must paint before any fetch resolves. Sharing `useVirtualMCPs`'
 * query key means this is usually a cache hit; when it isn't, the chip simply
 * appears a beat late. Never use this where a missing list is an error state —
 * it cannot tell "still loading" from "none".
 */
export function useVirtualMCPsNonBlocking(
  options: UseVirtualMCPsOptions = {},
): VirtualMCPEntity[] {
  return useVirtualMCPsNonBlockingState(options).items;
}

/** The non-suspending virtual-MCP list together with first-load state.
 *
 * Consumers that make routing decisions must distinguish an empty completed
 * list from a list whose self client or collection request is still pending;
 * otherwise a cold deep link can be rejected before dev/live aliases resolve.
 */
export function useVirtualMCPsNonBlockingState(
  options: UseVirtualMCPsOptions = {},
  enabled = true,
): { items: VirtualMCPEntity[]; pending: boolean; error: Error | null } {
  const { org } = useProjectContext();
  const clientQuery = useQuery(
    mcpClientQueryOptions({
      connectionId: SELF_MCP_ALIAS_ID,
      orgId: org.id,
      orgSlug: org.slug,
    }),
  );
  const client = clientQuery.data ?? null;

  const listQuery = useQuery({
    ...collectionListQueryOptions<VirtualMCPEntity>(
      org.id,
      "VIRTUAL_MCP",
      client,
      options,
    ),
    enabled: enabled && !!client,
  });

  return {
    items: listQuery.data ?? [],
    pending:
      enabled && (clientQuery.isPending || (!!client && listQuery.isPending)),
    error: enabled ? (clientQuery.error ?? listQuery.error) : null,
  };
}

/** One virtual MCP and its pending state, read WITHOUT suspending.
 *
 *  `ChatPrefsProvider` mounts ABOVE the sidebar and outside every Suspense
 *  boundary in the shell, so a suspending read there blanks the whole app back
 *  to the splash screen. Never use this where a missing entity is an error
 *  state. The explicit `pending` bit lets route chrome distinguish an entity
 *  still resolving from a completed missing/deleted entity. */
export function useVirtualMCPNonBlockingState(
  virtualMcpId: string | null | undefined,
): { item: VirtualMCPEntity | null; pending: boolean; error: Error | null } {
  const { org } = useProjectContext();
  const clientQuery = useQuery(
    mcpClientQueryOptions({
      connectionId: SELF_MCP_ALIAS_ID,
      orgId: org.id,
      orgSlug: org.slug,
    }),
  );
  const client = clientQuery.data ?? null;

  const query = useQuery({
    ...collectionItemQueryOptions<VirtualMCPEntity>(
      org.id,
      "VIRTUAL_MCP",
      virtualMcpId ?? undefined,
      client,
    ),
    enabled: !!client && !!virtualMcpId,
  });

  return {
    item: query.data?.item ?? null,
    pending:
      !!virtualMcpId &&
      (clientQuery.isPending || (!!client && query.isPending)),
    error: virtualMcpId ? (clientQuery.error ?? query.error) : null,
  };
}

export function useVirtualMCPNonBlocking(
  virtualMcpId: string | null | undefined,
): VirtualMCPEntity | null {
  return useVirtualMCPNonBlockingState(virtualMcpId).item;
}

/** The org's virtual MCPs, resolved OUTSIDE render — cache when warm, wire when
 *  not. The click-time twin of {@link useVirtualMCPsNonBlocking}: same cache
 *  entries, no suspend, no render-time data dependency. Both go through the
 *  shared query-options builders so the keys cannot drift. */
export async function fetchVirtualMCPs(
  queryClient: QueryClient,
  org: { id: string; slug: string },
  options: UseVirtualMCPsOptions = {},
): Promise<VirtualMCPEntity[]> {
  const client = await queryClient.fetchQuery(
    mcpClientQueryOptions({
      connectionId: SELF_MCP_ALIAS_ID,
      orgId: org.id,
      orgSlug: org.slug,
    }),
  );
  const listOptions = collectionListQueryOptions<VirtualMCPEntity>(
    org.id,
    "VIRTUAL_MCP",
    client,
    options,
  );
  /** `fetchQuery` returns the raw result — `select` is observer-level — so
   *  apply the options' own select rather than re-deriving the extraction. */
  return listOptions.select(await queryClient.fetchQuery(listOptions));
}

/**
 * The same list, keeping the page counts the server returns.
 *
 * Shares `useVirtualMCPsNonBlocking`'s query key exactly — only the `select`
 * differs — so asking for the count costs no extra request. Without this a
 * truncated list is indistinguishable from a complete one.
 */
export function useVirtualMCPsPage(options: UseVirtualMCPsOptions = {}): {
  items: VirtualMCPEntity[];
  totalCount?: number;
  hasMore?: boolean;
} {
  const { org } = useProjectContext();
  /** Non-blocking, for the same reason as `useVirtualMCPsNonBlocking` above:
   *  the sidebar's org/project picker calls this (for `hasMore` alone) and the
   *  sidebar mounts with no Suspense boundary of its own, so a suspending read
   *  escapes to the route boundary and replaces the PAINTED shell with the
   *  panel spinner — the backwards transition the boundary exists to prevent. */
  const client = useMCPClientNonBlocking({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data } = useQuery({
    ...collectionListPageQueryOptions<VirtualMCPEntity>(
      org.id,
      "VIRTUAL_MCP",
      client,
      options,
    ),
    enabled: !!client,
  });

  return {
    items: data?.items ?? [],
    totalCount: data?.totalCount,
    hasMore: data?.hasMore,
  };
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
