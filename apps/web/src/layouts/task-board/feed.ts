/**
 * The board read as a feed: what happened, newest first, grouped by the day it
 * happened on.
 *
 * Board and List both answer "what is there"; neither answers "what moved since
 * I last looked", which is the question anyone opening the board in the morning
 * actually has. A lane sorts by hand-dragged position and a list by filter, so
 * the single most recent thing in the org can sit anywhere on either — a feed
 * puts it first, and the day header is what turns a stack of rows into a
 * reading order.
 *
 * Built from the cards the board already loaded, so the view costs no request.
 * The per-card activity log (`TASK_BOARD_ACTIVITY_LIST`) is per ITEM — a feed
 * over it would be one request per card — so the event a row reports is derived
 * from the card's current state instead: the last thing that happened to a card
 * is, by definition, the state it is in now.
 */

import { DELIVERY_LANES } from "@decocms/shared/task-board";
import {
  agentRunState,
  isTaskBlocked,
  isTaskHandedToHuman,
  type TaskBoardItem,
} from "./config";

/**
 * What a row says happened. Ordered by urgency in {@link feedEventKind}, not by
 * this declaration — a card can be several of these at once (a failed run on a
 * card in review), and the one worth reading is the one someone has to act on.
 */
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

/**
 * How close the two timestamps have to be for a card to read as "created"
 * rather than "updated". They are written by one statement but not always in
 * the same millisecond, and a card created and immediately stamped with a
 * project is still, to a reader, a card that was just created.
 */
const CREATED_WINDOW_MS = 5_000;

export function feedEventKind(item: TaskBoardItem): FeedEventKind {
  if (isTaskBlocked(item)) return "blocked";
  const run = agentRunState(item);
  if (run === "running") return "running";
  if (run === "failed") return "failed";
  if (isTaskHandedToHuman(item)) return "handed";
  if (item.status === "done") return "done";
  /** Approved / Merged / Validating are each news, and each different news —
   *  the row names the event and lets the lane pill say which one. */
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

/** Local calendar day, NOT `toISOString()` — that is UTC, so everything after
 *  21:00 in São Paulo lands in tomorrow's group. */
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

/**
 * Cards newest-first, bucketed into the local day they last moved on.
 *
 * `now` is passed rather than read so "today" is decided by the caller — and so
 * the test can say what day it is. A card with an unparseable `updatedAt` is
 * dropped rather than grouped under the epoch: a feed is a claim about when,
 * and a row that cannot make that claim has nothing to say here.
 */
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
