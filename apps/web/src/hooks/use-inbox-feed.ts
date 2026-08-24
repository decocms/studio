/**
 * The inbox feed.
 *
 * NOT WIRED YET — this returns an empty feed, so the inbox renders its empty
 * state. Implementing it means fetching the updates and dropping them in here;
 * nothing else in the inbox UI needs to change.
 *
 * The shape below is the contract the surface is built against: one row per
 * unseen change to a task you follow, newest first, plus a count for the dot
 * and a way to clear it. `actorName` is null for the agent's own work, which is
 * what makes the row render the agent glyph instead of an avatar.
 *
 * The inbox carries task updates and nothing else. Product/release notes have
 * their own surface (the floating announcement card), invitations live in the
 * org switcher, and join requests in Settings → Members — so this stays a feed
 * of work you follow rather than a catch-all.
 */

export interface InboxTaskUpdate {
  id: string;
  taskBoardItemId: string;
  taskTitle: string;
  /** Per-org sequence behind the card's human key (`DECO-01`). */
  taskKeySeq: number;
  action: InboxTaskAction;
  /** Null for the agent/system — the row renders its glyph instead. */
  actorName: string | null;
  /** Falls back to initials when absent. */
  actorImage?: string | null;
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
  /** Unseen updates, newest first. */
  updates: InboxTaskUpdate[];
  /** What the unread dot counts. */
  redDotCount: number;
  markAllRead: () => void;
}

export function useInboxFeed(): InboxFeed {
  return {
    updates: [],
    redDotCount: 0,
    markAllRead: () => {},
  };
}
