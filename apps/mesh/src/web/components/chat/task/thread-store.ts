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
 */
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { CollectionListOutput } from "@decocms/bindings/collections";
import { useSuspenseQuery } from "@tanstack/react-query";
import { KEYS } from "../../../lib/query-keys";
import { TASK_CONSTANTS, type Task, type TasksQueryData } from "./types";

export type ThreadScope = "org" | { kind: "agent"; virtualMcpId: string };
export type ThreadStatusFilter = "open" | "archived";

export interface UseThreadsResult {
  threads: Task[];
  totalCount: number | undefined;
  hasMore: boolean;
  refetch: () => Promise<unknown>;
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

  const { data, refetch } = useSuspenseQuery<TasksQueryData>({
    queryKey: KEYS.threads(locator, scope),
    queryFn: async () => {
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
          offset: 0,
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
    staleTime: TASK_CONSTANTS.QUERY_STALE_TIME,
  });

  return {
    threads: data.items,
    totalCount: data.totalCount,
    hasMore: data.hasMore,
    refetch,
  };
}
