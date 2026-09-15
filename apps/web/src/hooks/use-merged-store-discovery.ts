/**
 * Hook that merges store discovery items from all enabled registries into a single list.
 * Each item is stamped with _sourceName, _sourceIcon, and _registryId.
 *
 * Uses two useInfiniteQuery calls — one for all non-community registries and one for
 * community. Within each group, registries are fetched in parallel and fail independently.
 * Non-community items are shown first, followed by community items. A failed
 * source stays visible as failure metadata instead of masquerading as an empty page.
 */

import { useInfiniteQuery, keepPreviousData } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { createMCPClient } from "@/sdk";
import { retry, RetryError } from "@decocms/shared/std";
import {
  inferRegistryListToolName,
  flattenPaginatedItems,
} from "@/utils/registry-utils";
import { KEYS } from "@/lib/query-keys";
import type { RegistryItem } from "@/components/store/types";

const PAGE_SIZE = 24;
const RETRY_ATTEMPTS = 3;

/** Minimal registry source descriptor — only needs id, title, icon */
export interface RegistrySource {
  id: string;
  title: string;
  icon: string | null;
}

export type RegistryDiscoveryFailure = RegistrySource;

export type RegistryDiscoveryHealth =
  | { status: "success"; failures: readonly [] }
  | {
      status: "partial-error" | "error";
      failures: readonly [
        RegistryDiscoveryFailure,
        ...RegistryDiscoveryFailure[],
      ];
    };

interface MergedDiscoveryResult {
  items: RegistryItem[];
  hasMore: boolean;
  isLoadingMore: boolean;
  isInitialLoading: boolean;
  isRetrying: boolean;
  health: RegistryDiscoveryHealth;
  loadMore: () => void;
  retryFailures: () => void;
}

/** Per-registry result within a group page */
interface RegistryPageSource {
  registryId: string;
  registryTitle: string;
  registryIcon: string | null;
}

export interface RegistryPageSuccess extends RegistryPageSource {
  status: "success";
  items: RegistryItem[];
  nextCursor?: string;
}

export interface RegistryPageFailure extends RegistryPageSource {
  status: "error";
}

export interface RegistryPageExhausted extends RegistryPageSource {
  status: "exhausted";
}

export type RegistryPageResult =
  | RegistryPageSuccess
  | RegistryPageFailure
  | RegistryPageExhausted;

/** Page param tracks cursors per registry within the group */
type PageParam = Record<string, string | null | undefined>;

interface RegistryPagesSummary {
  items: RegistryItem[];
  failures: RegistryDiscoveryFailure[];
  successfulRegistryIds: string[];
}

export function summarizeRegistryPages(
  pages: RegistryPageResult[][],
): RegistryPagesSummary {
  const items: RegistryItem[] = [];
  const failures = new Map<string, RegistryDiscoveryFailure>();
  const successfulRegistryIds = new Set<string>();

  for (const page of pages) {
    for (const result of page) {
      if (result.status === "error") {
        failures.set(result.registryId, {
          id: result.registryId,
          title: result.registryTitle,
          icon: result.registryIcon,
        });
        continue;
      }

      if (result.status === "exhausted") continue;

      successfulRegistryIds.add(result.registryId);
      for (const item of result.items) {
        items.push({
          ...item,
          _sourceName: item._sourceName ?? result.registryTitle,
          _sourceIcon: item._sourceIcon ?? result.registryIcon,
          _registryId: item._registryId ?? result.registryId,
        });
      }
    }
  }

  return {
    items,
    failures: [...failures.values()],
    successfulRegistryIds: [...successfulRegistryIds],
  };
}

export function getRegistryGroupNextPageParam(
  lastPage: RegistryPageResult[],
): PageParam | undefined {
  const nextCursors: PageParam = {};
  let anyHasMore = false;

  for (const result of lastPage) {
    if (result.status === "success" && result.nextCursor) {
      nextCursors[result.registryId] = result.nextCursor;
      anyHasMore = true;
    } else {
      // A terminal failure must not be mistaken for a successful empty page.
      // Refetching replays the same page and retries its original cursor.
      nextCursors[result.registryId] = null;
    }
  }

  return anyHasMore ? nextCursors : undefined;
}

export function getRegistryDiscoveryHealth(
  failures: RegistryDiscoveryFailure[],
  successfulRegistryIds: string[],
): RegistryDiscoveryHealth {
  const [firstFailure, ...remainingFailures] = failures;
  if (!firstFailure) return { status: "success", failures: [] };

  return {
    status: successfulRegistryIds.length > 0 ? "partial-error" : "error",
    failures: [firstFailure, ...remainingFailures],
  };
}

function isCommunityRegistry(registry: RegistrySource): boolean {
  return registry.id.includes("community-registry");
}

/**
 * Build a where expression for server-side search on registry items.
 * Searches title, description, name (server.name), and server.title.
 *
 * The search is split on whitespace into keywords, each OR'd across every
 * field — so "vtex shopify" surfaces items matching either (union), letting a
 * caller open the catalog pre-filtered to several providers at once.
 */
function buildRegistrySearchWhere(
  search: string | undefined,
): Record<string, unknown> | undefined {
  const tokens = search?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (tokens.length === 0) return undefined;
  const fields = [["title"], ["description"], ["name"], ["server", "title"]];
  return {
    operator: "or",
    conditions: tokens.flatMap((token) =>
      fields.map((field) => ({ field, operator: "contains", value: token })),
    ),
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

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isPlaceholderData,
    isRefetching,
    refetch,
  } = useInfiniteQuery({
    queryKey: KEYS.storeDiscovery(orgId, `${groupKey}:${search ?? ""}`),
    queryFn: async ({ pageParam }): Promise<RegistryPageResult[]> => {
      const cursors: PageParam = pageParam ?? {};

      return await Promise.all(
        registries.map(async (registry): Promise<RegistryPageResult> => {
          const cursor = cursors[registry.id];
          if (cursor === null) {
            return {
              status: "exhausted",
              registryId: registry.id,
              registryTitle: registry.title,
              registryIcon: registry.icon,
            };
          }

          const listToolName = inferRegistryListToolName(registry.id, orgId);

          // Per-registry retry since Promise.all would otherwise let one
          // failure reject the entire group.
          try {
            return await retry(
              async (): Promise<RegistryPageResult> => {
                let client: Awaited<ReturnType<typeof createMCPClient>> | null =
                  null;
                try {
                  client = await createMCPClient({
                    connectionId: registry.id,
                    orgId,
                    orgSlug,
                  });

                  const params: Record<string, unknown> = {
                    limit: PAGE_SIZE,
                  };
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

                  const payload = (result.structuredContent ??
                    result) as Record<string, unknown>;

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
                    status: "success",
                    registryId: registry.id,
                    registryTitle: registry.title,
                    registryIcon: registry.icon,
                    items,
                    nextCursor,
                  };
                } finally {
                  await client?.close().catch(() => {});
                }
              },
              {
                maxAttempts: RETRY_ATTEMPTS,
                minTimeout: 0,
                maxTimeout: 1000,
                jitter: 0,
              },
            );
          } catch (err) {
            // All retries exhausted. Preserve the failure as data so sibling
            // registries can render without turning this into a false empty state.
            console.warn(
              `[useMergedStoreDiscovery] Registry "${registry.title}" (${registry.id}) failed after ${RETRY_ATTEMPTS} attempts:`,
              err instanceof RetryError ? err.cause : err,
            );
            return {
              status: "error",
              registryId: registry.id,
              registryTitle: registry.title,
              registryIcon: registry.icon,
            };
          }
        }),
      );
    },
    initialPageParam: {} as PageParam,
    getNextPageParam: getRegistryGroupNextPageParam,
    staleTime: 60 * 60 * 1000,
    placeholderData: keepPreviousData,
    retry: false,
    enabled: enabled && registries.length > 0,
  });

  const summary = summarizeRegistryPages(data?.pages ?? []);
  const failures = isPlaceholderData ? [] : summary.failures;

  return {
    items: summary.items,
    failures,
    successfulRegistryIds: summary.successfulRegistryIds,
    hasMore: hasNextPage ?? false,
    isLoadingMore: isFetchingNextPage,
    isInitialLoading: isLoading,
    isRetrying: isRefetching,
    fetchNextPage: () => {
      if (hasNextPage && !isFetchingNextPage) {
        void fetchNextPage();
      }
    },
    retryFailures: () => {
      if (failures.length > 0 && !isRefetching && !isFetchingNextPage) {
        void refetch({ cancelRefetch: false });
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
  const failuresByRegistry = new Map<string, RegistryDiscoveryFailure>();
  for (const failure of [...ncQuery.failures, ...cQuery.failures]) {
    failuresByRegistry.set(failure.id, failure);
  }
  const failures = [...failuresByRegistry.values()];
  const successfulRegistryIds = [
    ...new Set([
      ...ncQuery.successfulRegistryIds,
      ...cQuery.successfulRegistryIds,
    ]),
  ];
  const health = getRegistryDiscoveryHealth(failures, successfulRegistryIds);

  const loadMore = () => {
    if (ncQuery.hasMore) ncQuery.fetchNextPage();
    if (cQuery.hasMore) cQuery.fetchNextPage();
  };

  const retryFailures = () => {
    ncQuery.retryFailures();
    cQuery.retryFailures();
  };

  return {
    items,
    hasMore,
    isLoadingMore,
    isInitialLoading,
    isRetrying: ncQuery.isRetrying || cQuery.isRetrying,
    health,
    loadMore,
    retryFailures,
  };
}
