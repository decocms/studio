/**
 * The inbox feed — DESIGN PREVIEW ONLY.
 *
 * Updates are hardcoded here so the inbox can be reviewed before any backend
 * exists. The real version reads them from the server (derived from the task
 * activity log against your subscriptions); `sampleUpdates()` is the only thing
 * that gets replaced.
 *
 * The inbox carries task updates and nothing else. Product/release notes have
 * their own surface (the floating announcement card), invitations live in the
 * org switcher, and join requests in Settings → Members — so this stays a feed
 * of work you follow rather than a catch-all.
 */

import { useState } from "react";

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

export interface InboxFeed {
  updates: InboxTaskUpdate[];
  /** Unread updates — what the dot counts. */
  redDotCount: number;
  markAllRead: () => void;
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
  const [readAt, setReadAt] = useState<number | null>(null);

  const updates = sampleUpdates().filter(
    (u) => readAt === null || new Date(u.occurredAt).getTime() > readAt,
  );

  return {
    updates,
    redDotCount: updates.length,
    markAllRead: () => setReadAt(Date.now()),
  };
}
