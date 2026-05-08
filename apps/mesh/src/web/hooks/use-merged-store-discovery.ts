/**
 * Hook that merges store discovery items from all enabled registries into a single list.
 * Each item is stamped with _sourceName, _sourceIcon, and _registryId.
 *
 * Uses two useInfiniteQuery calls — one for all non-community registries and one for
 * community. Within each group, registries are fetched in parallel via Promise.allSettled.
 * Non-community items are shown first; community items only appear after all
 * non-community registries are fully loaded (exhausted). Items always append at the
 * bottom — never insert mid-list.
 */

import { useInfiniteQuery, keepPreviousData } from "@tanstack/react-query";
import { useProjectContext } from "@decocms/mesh-sdk";
import { createMCPClient } from "@decocms/mesh-sdk";
import {
  inferRegistryListToolName,
  flattenPaginatedItems,
} from "@/web/utils/registry-utils";
import { KEYS } from "@/web/lib/query-keys";
import type { RegistryItem } from "@/web/components/store/types";

const PAGE_SIZE = 24;
const RETRY_ATTEMPTS = 3;

/** Minimal registry source descriptor — only needs id, title, icon */
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

/** Per-registry result within a group page */
interface RegistryPageResult {
  registryId: string;
  registryTitle: string;
  registryIcon: string | null;
  items: RegistryItem[];
  nextCursor?: string;
}

/** Page param tracks cursors per registry within the group */
type PageParam = Record<string, string | undefined>;

function isCommunityRegistry(registry: RegistrySource): boolean {
  return registry.id.includes("community-registry");
}

/**
 * Build a where expression for server-side search on registry items.
 * Searches title, description, name (server.name), and server.title.
 */
function buildRegistrySearchWhere(
  search: string | undefined,
): Record<string, unknown> | undefined {
  const trimmed = search?.trim();
  if (!trimmed) return undefined;
  return {
    operator: "or",
    conditions: [
      { field: ["title"], operator: "contains", value: trimmed },
      { field: ["description"], operator: "contains", value: trimmed },
      { field: ["name"], operator: "contains", value: trimmed },
      { field: ["server", "title"], operator: "contains", value: trimmed },
    ],
  };
}

/**
 * Fetches a page from a group of registries in parallel.
 * Each registry tracks its own cursor independently.
 */
function useRegistryGroupQuery(
  registries: RegistrySource[],
  orgId: string,
  orgSlug: string,
  enabled: boolean,
  search?: string,
) {
  const groupKey = registries
    .map((r) => r.id)
    .sort()
    .join(",");

  const where = buildRegistrySearchWhere(search);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery({
      queryKey: KEYS.storeDiscovery(orgId, `${groupKey}:${search ?? ""}`),
      queryFn: async ({ pageParam }): Promise<RegistryPageResult[]> => {
        const cursors: PageParam = pageParam ?? {};

        const results = await Promise.all(
          registries.map(async (registry): Promise<RegistryPageResult> => {
            const cursor = cursors[registry.id];
            if (cursor === "EXHAUSTED") {
              return {
                registryId: registry.id,
                registryTitle: registry.title,
                registryIcon: registry.icon,
                items: [],
              };
            }

            const listToolName = inferRegistryListToolName(registry.id, orgId);

            // Per-registry retry (2 attempts) since Promise.all would
            // otherwise let one failure reject the entire group
            let lastError: unknown;
            for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
              let client: Awaited<ReturnType<typeof createMCPClient>> | null =
                null;
              try {
                client = await createMCPClient({
                  connectionId: registry.id,
                  orgId,
                  orgSlug,
                });

                const params: Record<string, unknown> = { limit: PAGE_SIZE };
                if (cursor) {
                  params.cursor = cursor;
                }
                if (where) {
                  params.where = where;
                }

                const result = (await client.callTool({
                  name: listToolName,
                  arguments: params,
                })) as { structuredContent?: unknown };

                const payload = (result.structuredContent ?? result) as Record<
                  string,
                  unknown
                >;

                const nextCursor =
                  (payload as { nextCursor?: string; cursor?: string })
                    .nextCursor ||
                  (payload as { nextCursor?: string; cursor?: string })
                    .cursor ||
                  undefined;

                const items = flattenPaginatedItems<RegistryItem>(
                  payload ? [payload] : [],
                );

                return {
                  registryId: registry.id,
                  registryTitle: registry.title,
                  registryIcon: registry.icon,
                  items,
                  nextCursor,
                };
              } catch (err) {
                lastError = err;
              } finally {
                await client?.close().catch(() => {});
              }
            }

            // All retries exhausted — log and return empty so other registries
            // in the group are not affected
            console.warn(
              `[useMergedStoreDiscovery] Registry "${registry.title}" (${registry.id}) failed after ${RETRY_ATTEMPTS} attempts:`,
              lastError,
            );
            return {
              registryId: registry.id,
              registryTitle: registry.title,
              registryIcon: registry.icon,
              items: [],
            };
          }),
        );

        return results;
      },
      initialPageParam: {} as PageParam,
      getNextPageParam: (lastPage) => {
        const nextCursors: PageParam = {};
        let anyHasMore = false;

        for (const result of lastPage) {
          if (!result.registryId) continue;
          if (result.nextCursor) {
            nextCursors[result.registryId] = result.nextCursor;
            anyHasMore = true;
          } else {
            nextCursors[result.registryId] = "EXHAUSTED";
          }
        }

        return anyHasMore ? nextCursors : undefined;
      },
      staleTime: 60 * 60 * 1000,
      placeholderData: keepPreviousData,
      retry: false,
      enabled: enabled && registries.length > 0,
    });

  // Flatten all pages, stamp source metadata
  const items: RegistryItem[] = [];
  if (data?.pages) {
    for (const page of data.pages) {
      for (const registryResult of page) {
        for (const item of registryResult.items) {
          items.push({
            ...item,
            _sourceName: item._sourceName ?? registryResult.registryTitle,
            _sourceIcon: item._sourceIcon ?? registryResult.registryIcon,
            _registryId: item._registryId ?? registryResult.registryId,
          });
        }
      }
    }
  }

  return {
    items,
    hasMore: hasNextPage ?? false,
    isLoadingMore: isFetchingNextPage,
    isInitialLoading: isLoading,
    fetchNextPage: () => {
      if (hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
  };
}

export function useMergedStoreDiscovery(
  registries: RegistrySource[],
  search?: string,
): MergedDiscoveryResult {
  const { org } = useProjectContext();

  const nonCommunityRegistries = registries.filter(
    (r) => !isCommunityRegistry(r),
  );
  const communityRegistries = registries.filter((r) => isCommunityRegistry(r));

  // Both groups load in parallel. Non-community items render before community
  // items in the merged list (we push nc first), but the cQuery is no longer
  // gated on nc exhaustion — gating made community results invisible whenever
  // the previous-data hasMore was true (e.g. while typing a search, or while
  // any nc page was still pending).
  const ncQuery = useRegistryGroupQuery(
    nonCommunityRegistries,
    org.id,
    org.slug,
    true,
    search,
  );
  const cQuery = useRegistryGroupQuery(
    communityRegistries,
    org.id,
    org.slug,
    true,
    search,
  );

  // Collect all available items in priority order, deduplicating by registry+id
  const seen = new Set<string>();
  const items: RegistryItem[] = [];
  const allAvailable: RegistryItem[] = [...ncQuery.items, ...cQuery.items];
  for (const item of allAvailable) {
    const itemKey = `${item._registryId}:${item.id}`;
    if (!seen.has(itemKey)) {
      seen.add(itemKey);
      items.push(item);
    }
  }

  const isInitialLoading = ncQuery.isInitialLoading || cQuery.isInitialLoading;
  const isLoadingMore = ncQuery.isLoadingMore || cQuery.isLoadingMore;
  const hasMore = ncQuery.hasMore || cQuery.hasMore;

  const loadMore = () => {
    if (ncQuery.hasMore) ncQuery.fetchNextPage();
    if (cQuery.hasMore) cQuery.fetchNextPage();
  };

  return {
    items,
    hasMore,
    isLoadingMore,
    isInitialLoading,
    loadMore,
  };
}
