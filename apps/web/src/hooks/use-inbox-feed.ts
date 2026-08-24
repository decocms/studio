/**
 * The inbox feed: unread updates on the tasks you follow, then the release
 * notes.
 *
 * Not invitations and not join requests, deliberately. Invitations live in the
 * org switcher (`components/header/org-switcher.tsx`) and join requests in
 * Settings → Members; a second accept path would mean two components racing the
 * same mutation.
 *
 * Task updates come from the server (`TASK_BOARD_INBOX_LIST` derives them from
 * the activity log against your subscriptions); release "seen" state stays in
 * localStorage, since the changelog is a client-side constant.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useOrgFlag } from "@/hooks/use-organization-settings";
import { useReleaseSeenState } from "@/hooks/use-release-seen-state";
import { useTaskBoardEvents } from "@/hooks/use-task-board-events";
import { type Release, RELEASES } from "@/lib/release-feed";
import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";

export type InboxTaskUpdate =
  ToolOutput<"TASK_BOARD_INBOX_LIST">["items"][number];

export type InboxFeedItem =
  | { type: "task"; update: InboxTaskUpdate }
  | { type: "release"; release: Release; isSeen: boolean };

export interface InboxFeed {
  items: InboxFeedItem[];
  /** Unread task updates plus unseen releases — what the dot counts. */
  redDotCount: number;
  markReleaseSeen: (id: string) => void;
  markTasksRead: () => void;
}

/** A safety net only: an update normally arrives via the board's SSE stream. */
const REFETCH_INTERVAL_MS = 60_000;

export function useInboxFeed(): InboxFeed {
  const { locator, org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const enabled = useOrgFlag("task_notifications");
  const { isSeen, markSeen, unseenCount } = useReleaseSeenState();
  const queryKey = KEYS.notificationInbox(locator);

  const query = useQuery({
    queryKey,
    enabled,
    refetchInterval: REFETCH_INTERVAL_MS,
    queryFn: () => studio.call("TASK_BOARD_INBOX_LIST", { limit: 50 }),
  });

  // A board transition is what lands in the inbox, so reuse the board's stream.
  useTaskBoardEvents({
    orgSlug: org.slug,
    enabled,
    onUpdate: () => queryClient.invalidateQueries({ queryKey }),
  });

  const updates = query.data?.items ?? [];

  const markTasksRead = useMutation({
    // Through the newest rendered item, not `now`: later arrivals stay unread.
    mutationFn: () =>
      studio.call("TASK_BOARD_INBOX_MARK_READ", {
        through: updates[0]?.occurredAt,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const releases = [...RELEASES]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .map<InboxFeedItem>((release) => ({
      type: "release",
      release,
      isSeen: isSeen(release.id),
    }));

  return {
    items: [
      ...updates.map<InboxFeedItem>((update) => ({ type: "task", update })),
      ...releases,
    ],
    redDotCount: updates.length + unseenCount,
    markReleaseSeen: markSeen,
    markTasksRead: () => {
      if (updates.length > 0) markTasksRead.mutate();
    },
  };
}
