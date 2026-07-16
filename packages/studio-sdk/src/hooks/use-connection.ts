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
export interface UseConnectionsOptions
  extends UseCollectionListOptions<ConnectionEntity> {
  /**
   * Server-side binding filter. Only returns connections whose tools satisfy the binding.
   * Can be a well-known binding name (e.g., "LLM", "ASSISTANTS", "OBJECT_STORAGE")
   * or a custom binding schema object.
   */
  binding?: string | Record<string, unknown> | Record<string, unknown>[];
  /**
   * Whether to include VIRTUAL connections in results. Defaults to false (server default).
   */
  includeVirtual?: boolean;
  /**
   * Filter by computed connection slug (matches app_name, or slug derived from connection_url/title).
   */
  slug?: string;
}

/**
 * Hook to get connections with server-side filtering.
 *
 * @param options - Filter and configuration options (binding, search, etc.)
 * @returns Suspense query result with connections as ConnectionEntity[]
 */
export function useConnections(options: UseConnectionsOptions = {}) {
  const { binding, includeVirtual, slug, ...collectionOptions } = options;

  // Build additional tool args for the COLLECTION_CONNECTIONS_LIST tool
  const additionalToolArgs: Record<string, unknown> = {
    ...collectionOptions.additionalToolArgs,
  };

  if (binding !== undefined) {
    additionalToolArgs.binding = binding;
  }

  if (includeVirtual !== undefined) {
    additionalToolArgs.include_virtual = includeVirtual;
  }

  if (slug !== undefined) {
    additionalToolArgs.slug = slug;
  }

  const finalOptions: UseCollectionListOptions<ConnectionEntity> = {
    ...collectionOptions,
    additionalToolArgs:
      Object.keys(additionalToolArgs).length > 0
        ? additionalToolArgs
        : undefined,
  };

  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  return useCollectionList<ConnectionEntity>(
    org.id,
    "CONNECTIONS",
    client,
    finalOptions,
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
    orgSlug: org.slug,
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
    orgSlug: org.slug,
  });
  return useCollectionActions<ConnectionEntity>(org.id, "CONNECTIONS", client);
}
