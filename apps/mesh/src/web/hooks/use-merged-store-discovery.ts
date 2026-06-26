/**
 * Store discovery — lists items from the global registry catalog.
 *
 * The catalog is a single server-side source (the first-party `registry.json`),
 * served by mesh at `GET /api/registry/items`. Search + pagination happen
 * server-side; this hook is a thin TanStack `useInfiniteQuery` over that REST
 * endpoint.
 *
 * The `registries` parameter is retained for call-site compatibility but
 * ignored — there is one global catalog now, not a per-registry fan-out.
 */

import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useProjectContext } from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import type { RegistryItem } from "@/web/components/store/types";

const PAGE_SIZE = 24;

/** Minimal registry source descriptor — kept for call-site compatibility. */
export interface RegistrySource {
  id: string;
  title: string;
  icon: string | null;
}

interface MergedDiscoveryResult {
  items: RegistryItem[];
  hasMore: boolean;
  isLoadingMore: boolean;
  isInitialLoading: boolean;
  loadMore: () => void;
}

interface CatalogResponse {
  items: RegistryItem[];
  totalCount: number;
  nextCursor?: string;
}

async function fetchCatalogPage(
  search: string | undefined,
  cursor: string | undefined,
): Promise<CatalogResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  const trimmed = search?.trim();
  if (trimmed) params.set("search", trimmed);
  if (cursor) params.set("cursor", cursor);

  const res = await fetch(`/api/registry/items?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Failed to load registry catalog: ${res.status}`);
  }
  return (await res.json()) as CatalogResponse;
}

export function useMergedStoreDiscovery(
  _registries: RegistrySource[],
  search?: string,
): MergedDiscoveryResult {
  const { org } = useProjectContext();

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery({
      queryKey: KEYS.storeDiscovery(org.id, `catalog:${search ?? ""}`),
      queryFn: ({ pageParam }) => fetchCatalogPage(search, pageParam),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      staleTime: 60 * 60 * 1000,
      placeholderData: keepPreviousData,
    });

  const items: RegistryItem[] = (data?.pages ?? []).flatMap((p) => p.items);

  return {
    items,
    hasMore: hasNextPage ?? false,
    isLoadingMore: isFetchingNextPage,
    isInitialLoading: isLoading,
    loadMore: () => {
      if (hasNextPage && !isFetchingNextPage) fetchNextPage();
    },
  };
}
