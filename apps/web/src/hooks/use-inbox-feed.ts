/**
 * The inbox feed — DESIGN PREVIEW ONLY.
 *
 * Task updates are hardcoded here so the inbox can be reviewed before any
 * backend exists. The real version reads them from the server (derived from the
 * task activity log against your subscriptions); everything below the
 * `InboxFeed` boundary is what gets replaced. Release notes are already a
 * client-side constant, so those are wired for real.
 *
 * Deliberately NOT here: invitations and join requests. Invitations live in the
 * org switcher (`components/header/org-switcher.tsx`) and join requests in
 * Settings → Members; a second accept path would mean two components racing the
 * same mutation.
 */

import { useState } from "react";
import { useReleaseSeenState } from "@/hooks/use-release-seen-state";
import { type Release, RELEASES } from "@/lib/release-feed";

/** What a task update carries. Mirrors the shape the real feed will return. */
export interface InboxTaskUpdate {
  id: string;
  taskBoardItemId: string;
  taskTitle: string;
  taskKeySeq: number;
  action: InboxTaskAction;
  /** Null for the agent's own work — the row renders its glyph instead. */
  actorName: string | null;
  occurredAt: string;
}

export type InboxTaskAction =
  | "commented"
  | "created"
  | "status_changed"
  | "assignee_changed"
  | "review_requested"
  | "review_approved"
  | "review_changes_requested"
  | "merge_failed";

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

const minutesAgo = (n: number) =>
  new Date(Date.now() - n * 60_000).toISOString();

/** Enough variety to judge the row treatment: a human and an agent actor, a
 *  long title that has to truncate, and every action the row styles. */
function sampleUpdates(): InboxTaskUpdate[] {
  return [
    {
      id: "u1",
      taskBoardItemId: "t1",
      taskTitle: "Checkout drops the coupon field on mobile Safari",
      taskKeySeq: 12,
      action: "commented",
      actorName: "Ana Prado",
      occurredAt: minutesAgo(3),
    },
    {
      id: "u2",
      taskBoardItemId: "t2",
      taskTitle: "Add server-side rendering to the product listing page",
      taskKeySeq: 8,
      action: "review_approved",
      actorName: null,
      occurredAt: minutesAgo(21),
    },
    {
      id: "u3",
      taskBoardItemId: "t3",
      taskTitle: "Migrate the search index to the new analyzer",
      taskKeySeq: 31,
      action: "status_changed",
      actorName: "Bruno Salles",
      occurredAt: minutesAgo(96),
    },
    {
      id: "u4",
      taskBoardItemId: "t4",
      taskTitle: "Cart totals disagree with the order confirmation email",
      taskKeySeq: 4,
      action: "review_changes_requested",
      actorName: null,
      occurredAt: minutesAgo(240),
    },
    {
      id: "u5",
      taskBoardItemId: "t5",
      taskTitle: "Ship the new gift-card redemption flow",
      taskKeySeq: 27,
      action: "merge_failed",
      actorName: null,
      occurredAt: minutesAgo(1500),
    },
  ];
}

export function useInboxFeed(): InboxFeed {
  const { isSeen, markSeen, unseenCount } = useReleaseSeenState();
  const [readAt, setReadAt] = useState<number | null>(null);

  const updates = sampleUpdates().filter(
    (u) => readAt === null || new Date(u.occurredAt).getTime() > readAt,
  );

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
    markTasksRead: () => setReadAt(Date.now()),
  };
}
