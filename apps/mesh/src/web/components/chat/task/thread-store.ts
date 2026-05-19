/**
 * Thread Store — single source of truth for thread-list queries.
 *
 * Two query keys exist, by scope:
 *   - org:   KEYS.threads(locator, "org")
 *   - agent: KEYS.threads(locator, { kind: "agent", virtualMcpId })
 *
 * Filter dimensions (owner / hasTrigger / userId) are NEVER cache keys.
 * Consumers post-filter the returned array via `filterThreads` from
 * `./thread-filter`. This is the single, intentional fan-in that replaces
 * the previous fan-out across `useTasks` filter variants.
 *
 * Pagination: the query is an infinite query keyed by scope. Consumers
 * read `threads` (a flat array of every loaded page) and optionally call
 * `fetchNextPage()` to load more rows. The cache shape is
 * `{ pages: TasksPage[], pageParams: number[] }` — every cache mutator
 * (event bridge, helpers) must walk pages.
 */
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { CollectionListOutput } from "@decocms/bindings/collections";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { KEYS } from "../../../lib/query-keys";
import {
  TASK_CONSTANTS,
  type Task,
  type TasksPage,
  type ThreadScope,
} from "./types";

export type { ThreadScope } from "./types";
export type ThreadStatusFilter = "open" | "archived";

export interface UseThreadsResult {
  threads: Task[];
  totalCount: number | undefined;
  hasMore: boolean;
  refetch: () => Promise<unknown>;
  fetchNextPage: () => Promise<unknown>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}

export function useThreads(
  scope: ThreadScope,
  status: ThreadStatusFilter = "open",
): UseThreadsResult {
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery<TasksPage>({
      queryKey: KEYS.threads(locator, scope),
      queryFn: async ({ pageParam = 0 }) => {
        if (!client) throw new Error("MCP client is not available");

        // Scope is the only server-side narrowing — owner / hasTrigger
        // filtering happens client-side via filterThreads.
        const where: Record<string, unknown> = {
          hidden: status === "archived",
        };
        if (scope !== "org") {
          where.virtual_mcp_id = scope.virtualMcpId;
        }

        const result = (await client.callTool({
          name: "COLLECTION_THREADS_LIST",
          arguments: {
            limit: TASK_CONSTANTS.TASKS_PAGE_SIZE,
            offset: pageParam as number,
            orderBy: [{ field: ["updated_at"], direction: "desc" as const }],
            where,
          },
        })) as { structuredContent?: unknown };

        const payload = (result.structuredContent ??
          result) as CollectionListOutput<Task>;

        return {
          items: payload.items ?? [],
          hasMore: payload.hasMore ?? false,
          totalCount: payload.totalCount,
        };
      },
      initialPageParam: 0 as number,
      getNextPageParam: (lastPage, allPages) => {
        if (!lastPage.hasMore) return undefined;
        return allPages.length * TASK_CONSTANTS.TASKS_PAGE_SIZE;
      },
      staleTime: TASK_CONSTANTS.QUERY_STALE_TIME,
    });

  const lastPage = data.pages[data.pages.length - 1];
  return {
    threads: data.pages.flatMap((p) => p.items),
    totalCount: lastPage?.totalCount,
    hasMore: lastPage?.hasMore ?? false,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  };
}
