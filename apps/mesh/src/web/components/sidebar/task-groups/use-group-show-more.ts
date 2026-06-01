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
  buildShowMoreArgs,
  deriveGroupHasMore,
  GROUP_PAGE_SIZE,
  nextPageOffset,
  type GroupKind,
  type SidebarFilters,
} from "./next-page-offset";

interface ShowMoreState {
  isFetching: boolean;
  identity: string;
  /** Set after a per-group fetch; overrides `deriveGroupHasMore` when non-null. */
  serverHasMore: boolean | null;
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

function parseListResult(result: unknown): {
  items: Task[];
  hasMore: boolean;
} {
  const payload = ((result as { structuredContent?: unknown })
    .structuredContent ?? result) as {
    items?: Task[];
    hasMore?: boolean;
  };
  const items = Array.isArray(payload.items) ? payload.items : [];
  return {
    items,
    hasMore: payload.hasMore ?? items.length === GROUP_PAGE_SIZE,
  };
}

/**
 * Per-group "Show more" controller. Owns `hasMore`/`isFetching` for one
 * (kind, key, filters) tuple. Returns a `loadMore` callback that fetches
 * the next page from the server and merges it into the flat task list.
 *
 * `hasMore` resets whenever the identity (kind, key, filters) changes.
 * We use the "set state during render" pattern instead of useEffect to
 * comply with the no-useEffect lint rule.
 */
export function useGroupShowMore(
  kind: GroupKind,
  key: string,
  filters: SidebarFilters,
) {
  const identity = makeIdentity(kind, key, filters);
  const [state, setState] = useState<ShowMoreState>({
    isFetching: false,
    identity,
    serverHasMore: null,
  });
  if (state.identity !== identity) {
    setState({ isFetching: false, identity, serverHasMore: null });
  }

  const manager = useThreadManager();
  const { threads, hasMore: globalHasMore } = useThreads();
  const visibleCount = nextPageOffset(threads, kind, key, filters);
  const derivedHasMore = deriveGroupHasMore(visibleCount, globalHasMore);
  const hasMore =
    state.serverHasMore !== null ? state.serverHasMore : derivedHasMore;

  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  async function loadMore(): Promise<void> {
    if (state.isFetching) return;
    const capturedIdentity = identity;
    setState((s) =>
      s.identity === capturedIdentity ? { ...s, isFetching: true } : s,
    );
    try {
      const offset = nextPageOffset(threads, kind, key, filters);
      const args = buildShowMoreArgs(
        kind,
        key,
        offset,
        filters,
        GROUP_PAGE_SIZE,
      );

      const result = await client.callTool({
        name: "COLLECTION_THREADS_LIST",
        arguments: args as unknown as Record<string, unknown>,
      });

      if ((result as { isError?: boolean }).isError) {
        throw new Error(
          extractToolErrorMessage(result, "COLLECTION_THREADS_LIST failed"),
        );
      }

      const { items, hasMore: nextHasMore } = parseListResult(result);

      manager.mergeThreads(items);
      setState((s) => {
        if (s.identity !== capturedIdentity) return s;
        return {
          ...s,
          isFetching: false,
          serverHasMore: items.length === 0 ? false : nextHasMore,
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

  return { hasMore, isFetching: state.isFetching, loadMore };
}
