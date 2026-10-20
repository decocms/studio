import { useInfiniteQuery, keepPreviousData } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { KEYS } from "@/lib/query-keys";
import type { RegistryItem } from "@/components/store/types";

export function useRegistryCatalog(search?: string) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const tokens = search?.trim().split(/\s+/).filter(Boolean) ?? [];
  const query = useInfiniteQuery({
    queryKey: KEYS.storeDiscovery(org.id, `deco-json:${search ?? ""}`),
    queryFn: ({ pageParam }) =>
      studio.call("COLLECTION_REGISTRY_APP_LIST", {
        limit: 24,
        cursor: pageParam,
        where: tokens.length
          ? {
              operator: "or",
              conditions: tokens.flatMap((token) =>
                [["title"], ["description"], ["id"], ["server", "name"]].map(
                  (field) => ({
                    field,
                    operator: "contains" as const,
                    value: token,
                  }),
                ),
              ),
            }
          : undefined,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    throwOnError: true,
  });
  const items: RegistryItem[] =
    query.data?.pages.flatMap((page) => page.items) ?? [];
  return {
    items,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    isInitialLoading: query.isLoading,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage)
        void query.fetchNextPage();
    },
  };
}
