/**
 * Collection Hooks using React Query
 *
 * Provides React hooks for working with collection-binding-compliant tools.
 * Uses TanStack React Query for caching, loading states, and mutations.
 */

import {
  type BaseCollectionEntity,
  type CollectionDeleteInput,
  type CollectionDeleteOutput,
  type CollectionGetInput,
  type CollectionGetOutput,
  type CollectionInsertInput,
  type CollectionInsertOutput,
  type CollectionListInput,
  type CollectionListOutput,
  type CollectionUpdateInput,
  type CollectionUpdateOutput,
  type OrderByExpression,
  type WhereExpression,
} from "@decocms/bindings/collections";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { KEYS } from "../lib/query-keys";

/**
 * Collection entity base type that matches the collection binding pattern
 * Note: id can be nullable for synthetic entities like Decopilot agent
 */
export type CollectionEntity = Omit<BaseCollectionEntity, "id"> & {
  id: string | null;
};

/**
 * Filter definition for collection queries (matches @deco/ui Filter shape)
 */
export interface CollectionFilter {
  /** Field to filter on (must match an entity property) */
  column: string;
  /** Value to match */
  value: string | boolean | number;
}

/**
 * Options for useCollectionList hook
 */
export interface UseCollectionListOptions<T extends CollectionEntity> {
  /** Text search term (searches configured searchable fields) */
  searchTerm?: string;
  /** Field filters */
  filters?: CollectionFilter[];
  /** Sort key (field to sort by) */
  sortKey?: keyof T;
  /** Sort direction */
  sortDirection?: "asc" | "desc" | null;
  /** Fields to search when searchTerm is provided (default: ["title", "description"]) */
  searchFields?: (keyof T)[];
  /** Default sort key when none provided */
  defaultSortKey?: keyof T;
  /** Page size for pagination (default: 100) */
  pageSize?: number;
}

/**
 * Query key type for collection list queries
 */
export type CollectionQueryKey = readonly [
  unknown,
  string,
  string,
  "collection",
  string,
  "list",
  string,
];

/**
 * Build a where expression from search term and filters
 */
export function buildWhereExpression<T extends CollectionEntity>(
  searchTerm: string | undefined,
  filters: CollectionFilter[] | undefined,
  searchFields: (keyof T)[],
): WhereExpression | undefined {
  const conditions: WhereExpression[] = [];

  // Add search conditions (OR)
  if (searchTerm?.trim()) {
    const trimmedSearchTerm = searchTerm.trim();
    const searchConditions = searchFields.map((field) => ({
      field: [String(field)],
      operator: "contains" as const,
      value: trimmedSearchTerm,
    }));

    if (searchConditions.length === 1 && searchConditions[0]) {
      conditions.push(searchConditions[0]);
    } else if (searchConditions.length > 1) {
      conditions.push({
        operator: "or",
        conditions: searchConditions,
      });
    }
  }

  // Add filter conditions (AND)
  if (filters && filters.length > 0) {
    for (const filter of filters) {
      conditions.push({
        field: [filter.column],
        operator: "eq" as const,
        value: filter.value,
      });
    }
  }

  if (conditions.length === 0) {
    return undefined;
  }

  if (conditions.length === 1) {
    return conditions[0];
  }

  // Combine all conditions with AND
  return {
    operator: "and",
    conditions,
  };
}

/**
 * Build orderBy expression from sort key and direction
 */
export function buildOrderByExpression<T extends CollectionEntity>(
  sortKey: keyof T | undefined,
  sortDirection: "asc" | "desc" | null | undefined,
  defaultSortKey: keyof T,
): OrderByExpression[] | undefined {
  const key = sortKey ?? defaultSortKey;
  const direction = sortDirection ?? "asc";

  return [
    {
      field: [String(key)],
      direction,
    },
  ];
}

/**
 * Extract payload from MCP tool result (handles structuredContent wrapper)
 */
function extractPayload<T>(result: unknown): T {
  if (!result || typeof result !== "object") {
    throw new Error("Invalid result");
  }

  if ("isError" in result && result.isError) {
    throw new Error(
      "content" in result &&
        Array.isArray(result.content) &&
        result.content[0]?.type === "text"
        ? result.content[0].text
        : "Unknown error",
    );
  }

  if ("structuredContent" in result) {
    return result.structuredContent as T;
  }

  throw new Error("No structured content found");
}

/**
 * Get a single item by ID from a collection
 *
 * @param scopeKey - The scope key (connectionId for connection-scoped, virtualMcpId for virtual-mcp-scoped, etc.)
 * @param collectionName - The name of the collection (e.g., "CONNECTIONS", "AGENT")
 * @param itemId - The ID of the item to fetch (undefined returns null without making an API call)
 * @param client - The MCP client used to call collection tools
 * @returns Suspense query result with the item, or null if itemId is undefined
 */
export function useCollectionItem<T extends CollectionEntity>(
  scopeKey: string,
  collectionName: string,
  itemId: string | undefined,
  client: Client,
) {
  const upperName = collectionName.toUpperCase();
  const getToolName = `COLLECTION_${upperName}_GET`;

  const { data } = useSuspenseQuery({
    queryKey: KEYS.collectionItem(
      client,
      scopeKey,
      "",
      upperName,
      itemId ?? "",
    ),
    queryFn: async () => {
      if (!itemId) {
        return { item: null } satisfies CollectionGetOutput<T>;
      }

      const result = await client.callTool({
        name: getToolName,
        arguments: { id: itemId } satisfies CollectionGetInput,
      });

      return extractPayload<CollectionGetOutput<T>>(result);
    },
    staleTime: 60_000,
  });

  return data?.item ?? null;
}

/** Fake MCP result for empty collection list when client is skipped */
export const EMPTY_COLLECTION_LIST_RESULT = {
  structuredContent: {
    items: [],
  } satisfies CollectionListOutput<CollectionEntity>,
  isError: false,
} as const;

/**
 * Get a paginated list of items from a collection
 *
 * @param scopeKey - The scope key (connectionId for connection-scoped, virtualMcpId for virtual-mcp-scoped, etc.)
 * @param collectionName - The name of the collection (e.g., "CONNECTIONS", "AGENT")
 * @param client - The MCP client used to call collection tools (null/undefined returns [] without MCP call)
 * @param options - Filter and configuration options
 * @returns Suspense query result with items array
 */
export function useCollectionList<T extends CollectionEntity>(
  scopeKey: string,
  collectionName: string,
  client: Client | null | undefined,
  options: UseCollectionListOptions<T> = {},
) {
  const {
    searchTerm,
    filters,
    sortKey,
    sortDirection,
    searchFields = ["title", "description"] satisfies (keyof T)[],
    defaultSortKey = "updated_at" satisfies keyof T,
    pageSize = 100,
  } = options;

  const upperName = collectionName.toUpperCase();
  const listToolName = `COLLECTION_${upperName}_LIST`;

  const where = buildWhereExpression(searchTerm, filters, searchFields);
  const orderBy = buildOrderByExpression(
    sortKey,
    sortDirection,
    defaultSortKey,
  );

  const toolArguments: CollectionListInput = {
    ...(where && { where }),
    ...(orderBy && { orderBy }),
    limit: pageSize,
    offset: 0,
  };

  const argsKey = JSON.stringify(toolArguments);
  const queryKey = KEYS.collectionList(
    client,
    scopeKey,
    "",
    upperName,
    argsKey,
  );

  const { data } = useSuspenseQuery({
    queryKey,
    queryFn: async () => {
      if (!client) {
        return EMPTY_COLLECTION_LIST_RESULT;
      }
      const result = await client.callTool({
        name: listToolName,
        arguments: toolArguments,
      });
      return result;
    },
    staleTime: 30_000,
    retry: false,
    select: (result) => {
      const payload = extractPayload<CollectionListOutput<T>>(result ?? {});
      return payload?.items ?? [];
    },
  });

  return data;
}

/**
 * Builds a query key for a collection list query
 * Matches the internal logic of useCollectionList exactly
 *
 * @param client - The MCP client used to call collection tools (null/undefined is valid for skip queries)
 * @param collectionName - The name of the collection (e.g., "THREAD_MESSAGES", "CONNECTIONS")
 * @param scopeKey - The scope key (connectionId for connection-scoped, virtualMcpId for virtual-mcp-scoped, etc.)
 * @param options - Filter and configuration options
 * @returns Query key array
 */
export function buildCollectionQueryKey<T extends CollectionEntity>(
  client: Client | null | undefined,
  collectionName: string,
  scopeKey: string,
  options: UseCollectionListOptions<T> = {},
): CollectionQueryKey {
  const {
    searchTerm,
    filters,
    sortKey,
    sortDirection,
    searchFields = ["title", "description"] satisfies (keyof T)[],
    defaultSortKey = "updated_at" satisfies keyof T,
    pageSize = 100,
  } = options;

  const upperName = collectionName.toUpperCase();

  const where = buildWhereExpression(searchTerm, filters, searchFields);
  const orderBy = buildOrderByExpression(
    sortKey,
    sortDirection,
    defaultSortKey,
  );

  const toolArguments: CollectionListInput = {
    ...(where && { where }),
    ...(orderBy && { orderBy }),
    limit: pageSize,
    offset: 0,
  };

  const argsKey = JSON.stringify(toolArguments);
  return KEYS.collectionList(client, scopeKey, "", upperName, argsKey);
}

/**
 * Get mutation actions for create, update, and delete operations
 *
 * @param scopeKey - The scope key (connectionId for connection-scoped, virtualMcpId for virtual-mcp-scoped, etc.)
 * @param collectionName - The name of the collection (e.g., "CONNECTIONS", "AGENT")
 * @param client - The MCP client used to call collection tools
 * @returns Object with create, update, and delete mutation hooks
 */
export function useCollectionActions<T extends CollectionEntity>(
  scopeKey: string,
  collectionName: string,
  client: Client,
) {
  const queryClient = useQueryClient();
  const upperName = collectionName.toUpperCase();
  const createToolName = `COLLECTION_${upperName}_CREATE`;
  const updateToolName = `COLLECTION_${upperName}_UPDATE`;
  const deleteToolName = `COLLECTION_${upperName}_DELETE`;

  // Invalidate all collection queries for this scope and collection
  const invalidateCollection = () => {
    queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey;
        // Match collectionList/collectionItem keys: [client, scopeKey, "", "collection", collectionName, ...]
        return (
          key[1] === scopeKey && key[3] === "collection" && key[4] === upperName
        );
      },
    });
  };

  const create = useMutation({
    mutationFn: async (data: Partial<T>) => {
      const result = await client.callTool({
        name: createToolName,
        arguments: { data } satisfies CollectionInsertInput<T>,
      });

      if (result.isError) {
        throw new Error(
          Array.isArray(result.content)
            ? result.content[0]?.text
            : String(result.content),
        );
      }

      const payload = extractPayload<CollectionInsertOutput<T>>(result);

      return payload.item;
    },
    onSuccess: () => {
      invalidateCollection();
      toast.success("Item created successfully");
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Failed to create item: ${message}`);
    },
  });

  const update = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<T> }) => {
      const result = await client.callTool({
        name: updateToolName,
        arguments: { id, data } satisfies CollectionUpdateInput<T>,
      });
      const payload = extractPayload<CollectionUpdateOutput<T>>(result);

      return payload.item;
    },
    onSuccess: () => {
      invalidateCollection();
      toast.success("Item updated successfully");
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Failed to update item: ${message}`);
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const result = await client.callTool({
        name: deleteToolName,
        arguments: { id } satisfies CollectionDeleteInput,
      });
      const payload = extractPayload<CollectionDeleteOutput<T>>(result);

      return payload.item.id;
    },
    onSuccess: () => {
      invalidateCollection();
      toast.success("Item deleted successfully");
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Failed to delete item: ${message}`);
    },
  });

  return {
    create,
    update,
    delete: remove,
  };
}
