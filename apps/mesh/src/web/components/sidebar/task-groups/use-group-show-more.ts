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
    // The button stays visible even when hasMore is false so users can pull
    // in tasks that arrived later (SSE inserts, fresh runs, etc.). We only
    // guard against re-entrancy here.
    if (state.isFetching) return;
    const capturedIdentity = identity;
    setState((s) =>
      s.identity === capturedIdentity ? { ...s, isFetching: true } : s,
    );
    try {
      const offset = nextPageOffset(threads, kind, key, filters);
      const args = buildShowMoreArgs(kind, key, offset, filters, PAGE_SIZE);

      const result = await client.callTool({
        name: "COLLECTION_THREADS_LIST",
        arguments: args as unknown as Record<string, unknown>,
      });

      if ((result as { isError?: boolean }).isError) {
        throw new Error(
          extractToolErrorMessage(result, "COLLECTION_THREADS_LIST failed"),
        );
      }

      const raw = (result as { structuredContent?: { items?: unknown } })
        .structuredContent?.items;
      const items: Task[] = Array.isArray(raw) ? (raw as Task[]) : [];

      // Stale responses (filters/grouping changed mid-flight) are harmless:
      // `mergeThreads` dedupes by id and the rendered view re-filters and
      // re-sorts, so any rows that don't match the new identity are simply
      // ignored. The setState updater below guards hasMore/isFetching so
      // those don't leak across identities.
      manager.mergeThreads(items);
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
