import { useState } from "react";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { toast } from "sonner";
import {
  useThreadManager,
  useThreads,
} from "@/web/components/chat/store/hooks";
import type { Task } from "@/web/components/chat/task/types";
import { extractToolErrorMessage } from "@/web/components/chat/store/mcp-utils";
import {
  nextPageOffset,
  type GroupKind,
  type SidebarFilters,
} from "./next-page-offset";

const PAGE_SIZE = 10;

interface ShowMoreState {
  hasMore: boolean;
  isFetching: boolean;
  /** Identity snapshot — when filters or key change, state resets. */
  identity: string;
}

function makeIdentity(
  kind: GroupKind,
  key: string,
  filters: SidebarFilters,
): string {
  return [
    kind,
    key,
    filters.type,
    filters.member,
    filters.currentUserId ?? "",
  ].join("|");
}

/**
 * Per-group "Show more" controller. Owns `hasMore`/`isFetching` for one
 * (kind, key, filters) tuple. Returns a `loadMore` callback that fetches
 * the next page from the server and merges it into the flat task list.
 *
 * `hasMore` resets to `true` whenever the identity (kind, key, filters)
 * changes. We use the "set state during render" pattern instead of
 * useEffect to comply with the no-useEffect lint rule.
 */
export function useGroupShowMore(
  kind: GroupKind,
  key: string,
  filters: SidebarFilters,
) {
  const identity = makeIdentity(kind, key, filters);
  const [state, setState] = useState<ShowMoreState>({
    hasMore: true,
    isFetching: false,
    identity,
  });
  if (state.identity !== identity) {
    setState({ hasMore: true, isFetching: false, identity });
  }

  const manager = useThreadManager();
  const { threads } = useThreads();
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  async function loadMore(): Promise<void> {
    if (state.isFetching || !state.hasMore) return;
    const capturedIdentity = identity;
    setState((s) =>
      s.identity === capturedIdentity ? { ...s, isFetching: true } : s,
    );
    try {
      const where: Record<string, unknown> = {
        [kind === "agent" ? "virtual_mcp_id" : "status"]: key,
      };
      if (filters.member === "mine" && filters.currentUserId) {
        where.created_by = filters.currentUserId;
      }
      if (filters.type === "automation") where.has_trigger = true;
      if (filters.type === "manual") where.has_trigger = false;

      const offset = nextPageOffset(threads, kind, key, filters);

      const result = await client.callTool({
        name: "COLLECTION_THREADS_LIST",
        arguments: {
          where,
          limit: PAGE_SIZE,
          offset,
          orderBy: [{ field: ["updated_at"], direction: "desc" }],
        },
      });

      if ((result as { isError?: boolean }).isError) {
        throw new Error(
          extractToolErrorMessage(result, "COLLECTION_THREADS_LIST failed"),
        );
      }

      const raw = (result as { structuredContent?: { items?: unknown } })
        .structuredContent?.items;
      const items: Task[] = Array.isArray(raw) ? (raw as Task[]) : [];

      // Drop the response if the identity changed mid-flight (filters or
      // grouping switched). Merge into the store first so the next render
      // sees both the new tasks and the cleared isFetching together.
      if (identity === capturedIdentity) manager.mergeThreads(items);
      setState((s) => {
        if (s.identity !== capturedIdentity) return s;
        return {
          ...s,
          isFetching: false,
          hasMore: items.length === PAGE_SIZE,
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not load more tasks: ${msg}`);
      setState((s) =>
        s.identity === capturedIdentity ? { ...s, isFetching: false } : s,
      );
    }
  }

  return { hasMore: state.hasMore, isFetching: state.isFetching, loadMore };
}
