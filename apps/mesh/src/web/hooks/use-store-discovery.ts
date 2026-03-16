/**
 * Hook for store discovery data fetching
 *
 * Handles pagination, filtering, and data management for registry items.
 */

import { useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  keepPreviousData,
} from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import { flattenPaginatedItems } from "@/web/utils/registry-utils";
import { useMCPClient, useProjectContext } from "@decocms/mesh-sdk";
import type {
  RegistryItem,
  RegistryFiltersResponse,
  FilterItem,
} from "@/web/components/store/types";

const PAGE_SIZE = 24;

interface UseStoreDiscoveryOptions {
  registryId: string;
  listToolName: string;
  filtersToolName?: string;
  /** Search term for server-side filtering */
  search?: string;
}

interface UseStoreDiscoveryResult {
  /** Flattened list of registry items */
  items: RegistryItem[];
  /** Total count from API if available */
  totalCount: number | null;
  /** Whether more pages are available */
  hasMore: boolean;
  /** Whether currently loading more items */
  isLoadingMore: boolean;
  /** Whether filtering is in progress */
  isFiltering: boolean;
  /** Whether initial load is in progress */
  isInitialLoading: boolean;
  /** Whether fetching in background (for subtle loading indicator) */
  isFetching: boolean;
  /** Error from listing items (e.g. registry unreachable) */
  error: Error | null;
  /** Function to load more items */
  loadMore: () => void;
  /** Available tags for filtering */
  availableTags?: FilterItem[];
  /** Available categories for filtering */
  availableCategories?: FilterItem[];
  /** Currently selected tags */
  selectedTags: string[];
  /** Currently selected categories */
  selectedCategories: string[];
  /** Update selected tags */
  setSelectedTags: (tags: string[]) => void;
  /** Update selected categories */
  setSelectedCategories: (categories: string[]) => void;
  /** Whether any filters are active */
  hasActiveFilters: boolean;
}

/**
 * Hook for fetching and managing store discovery data
 */
export function useStoreDiscovery({
  registryId,
  listToolName,
  filtersToolName,
  search,
}: UseStoreDiscoveryOptions): UseStoreDiscoveryResult {
  const { org } = useProjectContext();
  // Filter state
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);

  const client = useMCPClient({
    connectionId: registryId || null,
    orgId: org.id,
  });
  const hasFiltersSupport = Boolean(filtersToolName);

  // Fetch available filters (only if supported)
  // Uses useQuery (not useSuspenseQuery) so that a failing registry
  // doesn't crash the entire Store UI — filters degrade gracefully to empty.
  const { data: filtersData } = useQuery<RegistryFiltersResponse>({
    queryKey: KEYS.toolCall(registryId, filtersToolName || "no-filters", "{}"),
    queryFn: async () => {
      if (!filtersToolName) {
        return { tags: [], categories: [] };
      }
      const result = (await client.callTool({
        name: filtersToolName,
        arguments: {},
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as RegistryFiltersResponse;
    },
    staleTime: 60 * 60 * 1000, // 1 hour - filters don't change often
    retry: 2,
  });

  // Build where clause for server-side search
  // Only search if there's actually a search term
  const searchWhereClause = search?.trim()
    ? {
        operator: "or" as const,
        conditions: [
          { field: ["name"], operator: "contains" as const, value: search },
          { field: ["title"], operator: "contains" as const, value: search },
          {
            field: ["description"],
            operator: "contains" as const,
            value: search,
          },
        ],
      }
    : undefined;

  // Build filter params for the LIST API call
  const filterParams = {
    limit: PAGE_SIZE,
    ...(selectedTags.length > 0 && { tags: selectedTags }),
    ...(selectedCategories.length > 0 && { categories: selectedCategories }),
    ...(searchWhereClause && { where: searchWhereClause }),
  };

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetching,
    isLoading,
    error: listError,
  } = useInfiniteQuery({
    queryKey: KEYS.toolCall(
      registryId,
      listToolName,
      JSON.stringify(filterParams),
    ),
    queryFn: async ({ pageParam }) => {
      const params = pageParam
        ? { ...filterParams, cursor: pageParam }
        : filterParams;
      const result = (await client.callTool({
        name: listToolName,
        arguments: params,
      })) as { structuredContent?: unknown };
      return result.structuredContent ?? result;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => {
      if (typeof lastPage === "object" && lastPage !== null) {
        const nextCursor =
          (lastPage as { nextCursor?: string; cursor?: string }).nextCursor ||
          (lastPage as { nextCursor?: string; cursor?: string }).cursor;

        if (nextCursor) {
          return nextCursor;
        }
      }
      return undefined;
    },
    staleTime: 60 * 60 * 1000,
    placeholderData: keepPreviousData,
    retry: 2,
  });

  // Extract totalCount from first page if available
  const totalCount = (() => {
    if (!data?.pages || data.pages.length === 0) return null;
    const firstPage = data.pages[0];
    if (
      typeof firstPage === "object" &&
      firstPage !== null &&
      "totalCount" in firstPage &&
      typeof firstPage.totalCount === "number"
    ) {
      return firstPage.totalCount;
    }
    return null;
  })();

  // Flatten all pages into a single array of items
  const items = flattenPaginatedItems<RegistryItem>(data?.pages);

  const hasActiveFilters =
    selectedTags.length > 0 ||
    selectedCategories.length > 0 ||
    Boolean(search?.trim());

  // Show filtering indicator when fetching due to filter change
  const isFiltering =
    isFetching && !isFetchingNextPage && !isLoading && hasActiveFilters;

  const loadMore = () => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  };

  return {
    items,
    totalCount,
    hasMore: hasNextPage ?? false,
    isLoadingMore: isFetchingNextPage,
    isFiltering,
    isInitialLoading: isLoading,
    isFetching,
    error: listError,
    loadMore,
    availableTags: hasFiltersSupport
      ? (filtersData as RegistryFiltersResponse | undefined)?.tags
      : undefined,
    availableCategories: hasFiltersSupport
      ? (filtersData as RegistryFiltersResponse | undefined)?.categories
      : undefined,
    selectedTags,
    selectedCategories,
    setSelectedTags,
    setSelectedCategories,
    hasActiveFilters,
  };
}
