/**
 * The board read as a feed: what moved, newest first, grouped by local day.
 *
 * Built from the cards the board already loaded, so it costs no request. The
 * per-card activity log is per ITEM, so a row's event is derived from the
 * card's current state instead.
 */

import { DELIVERY_LANES } from "@decocms/shared/task-board";
import {
  agentRunState,
  isTaskBlocked,
  isTaskHandedToHuman,
  type TaskBoardItem,
} from "./config";

/** What a row says happened. {@link feedEventKind} orders these by urgency, not
 *  this declaration: a card can be several at once. */
export type FeedEventKind =
  | "blocked"
  | "running"
  | "failed"
  | "handed"
  | "done"
  | "delivered"
  | "review"
  | "created"
  | "updated";

/** How close `createdAt` and `updatedAt` must be for a card to read as
 *  created rather than updated — one statement, not one millisecond. */
const CREATED_WINDOW_MS = 5_000;

export function feedEventKind(item: TaskBoardItem): FeedEventKind {
  if (isTaskBlocked(item)) return "blocked";
  const run = agentRunState(item);
  if (run === "running") return "running";
  if (run === "failed") return "failed";
  if (isTaskHandedToHuman(item)) return "handed";
  if (item.status === "done") return "done";
  /** The row names the event; the lane pill says which one. */
  if ((DELIVERY_LANES as string[]).includes(item.status)) return "delivered";
  if (item.status === "in_review") return "review";
  const age = Date.parse(item.updatedAt) - Date.parse(item.createdAt);
  return Number.isFinite(age) && age < CREATED_WINDOW_MS
    ? "created"
    : "updated";
}

/** One day's worth of the feed. */
export interface FeedDay {
  /** Local `YYYY-MM-DD` — the React key, and stable across a re-sort. */
  key: string;
  /** `null` for any day the reader has no word for, which gets a date. */
  relative: "today" | "yesterday" | null;
  date: Date;
  items: TaskBoardItem[];
}

/** Local calendar day, NOT `toISOString()`: UTC puts everything after 21:00 in
 *  São Paulo in tomorrow's group. */
function dayKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function daysBetween(a: Date, b: Date): number {
  const startOf = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOf(a) - startOf(b)) / 86_400_000);
}

/** Cards newest-first, bucketed by local day. `now` is passed so the caller
 *  (and the test) decides what day it is; an unparseable `updatedAt` drops the
 *  card rather than grouping it under the epoch. */
export function groupFeedByDay(
  items: readonly TaskBoardItem[],
  now: Date,
): FeedDay[] {
  const days = new Map<string, FeedDay>();

  const dated = items
    .map((item) => ({ item, at: new Date(item.updatedAt) }))
    .filter(({ at }) => Number.isFinite(at.getTime()))
    .sort((a, b) => b.at.getTime() - a.at.getTime());

  for (const { item, at } of dated) {
    const key = dayKey(at);
    const existing = days.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    const distance = daysBetween(now, at);
    days.set(key, {
      key,
      date: at,
      relative: distance === 0 ? "today" : distance === 1 ? "yesterday" : null,
      items: [item],
    });
  }

  return [...days.values()];
}
