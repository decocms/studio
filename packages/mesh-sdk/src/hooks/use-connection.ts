/**
 * Connection Collection Hooks
 *
 * Provides React hooks for working with connections using React Query.
 * These hooks offer a reactive interface for accessing and manipulating connections.
 */

import type { ConnectionEntity } from "../types/connection";
import { useProjectContext } from "../context/project-context";
import {
  type CollectionFilter,
  useCollectionActions,
  useCollectionItem,
  useCollectionList,
  useCollectionListAsync,
  useCollectionListInfinite,
  type UseCollectionListOptions,
} from "./use-collections";
import { useMCPClient } from "./use-mcp-client";
import { SELF_MCP_ALIAS_ID } from "../lib/constants";

/**
 * Filter definition for connections (matches @deco/ui Filter shape)
 */
export type ConnectionFilter = CollectionFilter;

/**
 * Options for useConnections hook
 */
export type UseConnectionsOptions = UseCollectionListOptions<ConnectionEntity>;

/**
 * Hook to get all connections
 *
 * @param options - Filter and configuration options
 * @returns Suspense query result with connections as ConnectionEntity[]
 */
export function useConnections(options: UseConnectionsOptions = {}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  return useCollectionList<ConnectionEntity>(
    org.id,
    "CONNECTIONS",
    client,
    options,
  );
}

/**
 * Non-suspense variant of useConnections for background/lazy loading.
 * Returns { data, isLoading } instead of blocking render.
 */
export function useConnectionsAsync(options: UseConnectionsOptions = {}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  return useCollectionListAsync<ConnectionEntity>(
    org.id,
    "CONNECTIONS",
    client,
    options,
  );
}

/**
 * Infinite-scroll variant of useConnections.
 * Loads connections in pages of 20, with loadMore/hasMore for scroll-driven pagination.
 */
export function useConnectionsInfinite(options: UseConnectionsOptions = {}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  return useCollectionListInfinite<ConnectionEntity>(
    org.id,
    "CONNECTIONS",
    client,
    options,
  );
}

/**
 * Hook to get a single connection by ID
 *
 * @param connectionId - The ID of the connection to fetch (undefined returns null without making an API call)
 * @returns Suspense query result with the connection as ConnectionEntity | null
 */
export function useConnection(connectionId: string | undefined) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  return useCollectionItem<ConnectionEntity>(
    org.id,
    "CONNECTIONS",
    connectionId,
    client,
  );
}

/**
 * Hook to get connection mutation actions (create, update, delete)
 *
 * @returns Object with create, update, and delete mutation hooks
 */
export function useConnectionActions() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  return useCollectionActions<ConnectionEntity>(org.id, "CONNECTIONS", client);
}
