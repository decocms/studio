/**
 * The inbox feed: unread changes to tasks you follow, newest first.
 *
 * The inbox carries task updates and nothing else. Product/release notes have
 * their own surface (the floating announcement card), invitations live in the
 * org switcher, and join requests in Settings → Members — so this stays a feed
 * of work you follow rather than a catch-all.
 *
 * Live, not polled: the org `/watch` stream carries `notification.created` and
 * the poll below is only the fallback for a dropped connection. Marking read is
 * optimistic in both directions — the row leaves the list on click, and the
 * server call only confirms it.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useProjectContext } from "@/sdk";
import { authClient } from "@/lib/auth-client";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import type { NotificationType } from "@decocms/shared/notification-types";
import { notificationWatchView } from "./watch-sse-pool";

export interface InboxTaskUpdate {
  id: string;
  taskBoardItemId: string;
  taskTitle: string;
  /** Per-org sequence behind the card's human key (`DECO-01`). */
  taskKeySeq: number | null;
  action: InboxTaskAction;
  /** Null for the agent/system — the row renders its glyph instead. */
  actorName: string | null;
  /** Falls back to initials when absent. */
  actorImage?: string | null;
  occurredAt: string;
}

export type InboxTaskAction = NotificationType;

export interface InboxFeed {
  /** Unseen updates, newest first — every page loaded so far. */
  updates: InboxTaskUpdate[];
  /** What the unread dot counts (the full unread total, not the loaded pages). */
  redDotCount: number;
  hasMore: boolean;
  isFetchingMore: boolean;
  fetchMore: () => void;
  markAllRead: () => void;
  /** Read one row — what opening a notification does. */
  markRead: (id: string) => void;
}

/** Fallback only: the SSE stream is the real signal, this covers a dead one. */
const POLL_MS = 60_000;

type Page = Awaited<ReturnType<typeof listNotifications>>;
type ListFn = ReturnType<typeof useStudioTools>;

function listNotifications(studio: ListFn, cursor?: string) {
  return studio.call("NOTIFICATION_LIST", cursor ? { cursor } : {});
}

/**
 * Drop rows locally and decrement the count by however many were actually
 * dropped — never by the caller's guess, so a double click can't drive the dot
 * negative. `ids: null` means "everything loaded", which is what Mark all read
 * shows; the server still clears rows past the loaded pages, and `unreadCount`
 * goes to 0 with them.
 */
export function dropLocally(
  data: InfiniteData<Page> | undefined,
  ids: string[] | null,
): InfiniteData<Page> | undefined {
  if (!data) return data;
  const drop = ids ? new Set(ids) : null;
  let removed = 0;
  const pages = data.pages.map((page) => {
    const notifications = page.notifications.filter((n) => {
      if (drop && !drop.has(n.id)) return true;
      removed++;
      return false;
    });
    return { ...page, notifications };
  });
  const unreadCount = drop
    ? Math.max(0, (data.pages[0]?.unreadCount ?? 0) - removed)
    : 0;
  return {
    ...data,
    pages: pages.map((page) => ({ ...page, unreadCount })),
  };
}

/** Refetch the feed when the org stream says a row landed for me. */
function useLiveInbox(orgSlug: string, onNotification: () => void): void {
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  useSyncExternalStore(
    (onStoreChange) => {
      if (!orgSlug || !userId) return () => {};
      const unsubscribe = notificationWatchView.subscribe(
        orgSlug,
        (event: MessageEvent) => {
          try {
            // The event carries only its recipient; the row itself is refetched.
            const parsed = JSON.parse(event.data) as { subject?: string };
            if (parsed.subject !== userId) return;
          } catch {
            return;
          }
          onNotification();
          onStoreChange();
        },
        // A reconnect may have missed events — resync.
        onNotification,
      );
      return unsubscribe;
    },
    () => 0,
    () => 0,
  );
}

export function useInboxFeed(): InboxFeed {
  const { locator, org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const queryKey = KEYS.notifications(locator);

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      listNotifications(studio, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: POLL_MS,
  });

  useLiveInbox(org.slug, () =>
    queryClient.invalidateQueries({ queryKey, refetchType: "active" }),
  );

  const markRead = useMutation({
    /** `ids: undefined` is the server's "all of mine in this org". */
    mutationFn: (ids: string[] | null) =>
      studio.call("NOTIFICATION_MARK_READ", ids ? { ids } : {}),
    onMutate: (ids) => {
      queryClient.setQueryData<InfiniteData<Page>>(queryKey, (data) =>
        dropLocally(data, ids),
      );
    },
    // Failed or not, the server is the truth about what is still unread.
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const pages = query.data?.pages ?? [];

  return {
    updates: pages.flatMap((page) =>
      page.notifications.map((n) => ({
        id: n.id,
        taskBoardItemId: n.taskBoardItemId,
        taskTitle: n.taskTitle,
        taskKeySeq: n.taskKeySeq,
        action: n.type,
        actorName: n.actorName,
        actorImage: n.actorImage,
        occurredAt: n.createdAt,
      })),
    ),
    redDotCount: pages[0]?.unreadCount ?? 0,
    hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    fetchMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
    },
    markAllRead: () => markRead.mutate(null),
    markRead: (id: string) => markRead.mutate([id]),
  };
}
