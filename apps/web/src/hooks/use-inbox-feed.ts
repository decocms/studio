/**
 * The inbox feed: unread changes to tasks you follow, newest first.
 *
 * The inbox carries task updates and nothing else. Product/release notes have
 * their own surface (the floating announcement card), invitations live in the
 * org switcher, and join requests in Settings → Members — so this stays a feed
 * of work you follow rather than a catch-all.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import type { NotificationType } from "@decocms/shared/notification-types";

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
  /** Unseen updates, newest first. */
  updates: InboxTaskUpdate[];
  /** What the unread dot counts. */
  redDotCount: number;
  markAllRead: () => void;
}

/** The dot's freshness ceiling — the popover refetches on open anyway. */
const POLL_MS = 60_000;

export function useInboxFeed(): InboxFeed {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const queryKey = KEYS.notifications(locator);

  const query = useQuery({
    queryKey,
    queryFn: () => studio.call("NOTIFICATION_LIST", {}),
    refetchInterval: POLL_MS,
  });

  const markAllRead = useMutation({
    mutationFn: () => studio.call("NOTIFICATION_MARK_READ", {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  return {
    updates: (query.data?.notifications ?? []).map((n) => ({
      id: n.id,
      taskBoardItemId: n.taskBoardItemId,
      taskTitle: n.taskTitle,
      taskKeySeq: n.taskKeySeq,
      action: n.type,
      actorName: n.actorName,
      actorImage: n.actorImage,
      occurredAt: n.createdAt,
    })),
    redDotCount: query.data?.unreadCount ?? 0,
    markAllRead: () => markAllRead.mutate(),
  };
}
