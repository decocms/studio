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
  groupHasMoreFromTotal,
  GROUP_PAGE_SIZE,
  nextPageOffset,
  resolveGroupHasMore,
  threadMatchesSidebarGroup,
  type GroupKind,
  type SidebarFilters,
} from "./next-page-offset";

interface ShowMoreState {
  isFetching: boolean;
  isProbing: boolean;
  identity: string;
  /** Authoritative once probed or after a per-group page fetch. */
  serverHasMore: boolean | null;
}

function makeIdentity(
  orgId: string,
  kind: GroupKind,
  key: string,
  filters: SidebarFilters,
): string {
  return [
    orgId,
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
  totalCount?: number;
} {
  const payload = ((result as { structuredContent?: unknown })
    .structuredContent ?? result) as {
    items?: Task[];
    hasMore?: boolean;
    totalCount?: number;
  };
  const items = Array.isArray(payload.items) ? payload.items : [];
  return {
    items,
    hasMore: payload.hasMore ?? items.length === GROUP_PAGE_SIZE,
    totalCount:
      typeof payload.totalCount === "number" ? payload.totalCount : undefined,
  };
}

function countNewMatchingItems(
  items: Task[],
  loadedIds: Set<string>,
  kind: GroupKind,
  key: string,
  filters: SidebarFilters,
): number {
  let count = 0;
  for (const item of items) {
    if (loadedIds.has(item.id)) continue;
    if (!threadMatchesSidebarGroup(item, kind, key, filters)) continue;
    count++;
  }
  return count;
}

/**
 * Per-group "Show more" controller. Owns `hasMore`/`isFetching` for one
 * (org, kind, key, filters) tuple.
 */
export function useGroupShowMore(
  kind: GroupKind,
  key: string,
  filters: SidebarFilters,
  /** Precomputed visible count for this group (avoids O(T) scan per hook). */
  visibleCount?: number,
) {
  const { org } = useProjectContext();
  const identity = makeIdentity(org.id, kind, key, filters);
  const [state, setState] = useState<ShowMoreState>({
    isFetching: false,
    isProbing: false,
    identity,
    serverHasMore: null,
  });
  if (state.identity !== identity) {
    setState({
      isFetching: false,
      isProbing: false,
      identity,
      serverHasMore: null,
    });
  }

  const manager = useThreadManager();
  const { threads, hasMore: globalHasMore } = useThreads();
  const resolvedVisibleCount =
    visibleCount ?? nextPageOffset(threads, kind, key, filters);
  const derivedHasMore = deriveGroupHasMore(
    resolvedVisibleCount,
    globalHasMore,
  );

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  if (
    state.identity === identity &&
    state.serverHasMore === null &&
    !state.isProbing &&
    !state.isFetching
  ) {
    const capturedIdentity = identity;
    setState((s) =>
      s.identity === capturedIdentity ? { ...s, isProbing: true } : s,
    );
    void (async () => {
      try {
        const args = buildShowMoreArgs(kind, key, 0, filters, 1);
        const result = await client.callTool({
          name: "COLLECTION_THREADS_LIST",
          arguments: args as unknown as Record<string, unknown>,
        });
        if ((result as { isError?: boolean }).isError) {
          throw new Error(
            extractToolErrorMessage(result, "COLLECTION_THREADS_LIST failed"),
          );
        }
        const { totalCount } = parseListResult(result);
        const visible = nextPageOffset(
          manager.threads.get(),
          kind,
          key,
          filters,
        );
        setState((s) => {
          if (s.identity !== capturedIdentity) return s;
          return {
            ...s,
            isProbing: false,
            serverHasMore:
              totalCount === undefined
                ? null
                : groupHasMoreFromTotal(visible, totalCount),
          };
        });
      } catch {
        setState((s) =>
          s.identity === capturedIdentity ? { ...s, isProbing: false } : s,
        );
      }
    })();
  }

  async function loadMore(): Promise<void> {
    if (state.isFetching || state.isProbing) return;
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

      const {
        items,
        hasMore: nextHasMore,
        totalCount,
      } = parseListResult(result);

      const loadedIds = new Set(threads.map((t) => t.id));
      const newMatchingCount = countNewMatchingItems(
        items,
        loadedIds,
        kind,
        key,
        filters,
      );
      const knownBefore = offset;

      manager.mergeThreads(items);
      setState((s) => {
        if (s.identity !== capturedIdentity) return s;
        let serverHasMore: boolean;
        if (totalCount !== undefined) {
          serverHasMore = groupHasMoreFromTotal(
            knownBefore + newMatchingCount,
            totalCount,
          );
        } else {
          serverHasMore =
            items.length === 0 || newMatchingCount === 0 ? false : nextHasMore;
        }
        return {
          ...s,
          isFetching: false,
          serverHasMore,
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

  const isBusy = state.isFetching || state.isProbing;
  const showButton =
    !isBusy && resolveGroupHasMore(derivedHasMore, state.serverHasMore);

  return { hasMore: showButton, isFetching: isBusy, loadMore };
}
