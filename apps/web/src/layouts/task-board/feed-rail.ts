/**
 * What belongs beside the feed: the state of the work right now.
 *
 * The rail used to hold the project's owner, repo and folder — facts that are
 * true whether or not anything is happening, and already answered by the
 * project's settings and the Library. A feed is read to find out what is going
 * on, so its margin answers the two live questions the page itself cannot: what
 * is an agent doing this second, and what has stopped waiting on a person.
 *
 * Pure and derived from the board the feed already loaded, so nothing new is
 * fetched and the rail can never disagree with the rows next to it.
 */

import {
  isLiveAttempt,
  isTaskBlocked,
  isTaskHandedToHuman,
  type TaskBoardItem,
  type TaskBoardItemThread,
} from "./config";

/** How many rows either section shows before it stops. A rail is a glance: past
 *  a handful it competes with the feed it sits beside. */
const FEED_RAIL_LIMIT = 5;

/** One live run: the card it is on, and the attempt that is running. */
export interface RunningEntry {
  item: TaskBoardItem;
  thread: TaskBoardItemThread;
}

export interface FeedRail {
  /** Agents working, longest-silent last. */
  running: RunningEntry[];
  /** Cards stopped on a person: an agent asked something, or the automation
   *  handed the card back. */
  waiting: TaskBoardItem[];
  /** Totals before `FEED_RAIL_LIMIT` cut them. */
  runningTotal: number;
  waitingTotal: number;
}

function newestLiveRun(item: TaskBoardItem): TaskBoardItemThread | undefined {
  return item.threads
    .filter(isLiveAttempt)
    .find((thread) => thread.status === "in_progress");
}

export function feedRail(items: readonly TaskBoardItem[]): FeedRail {
  const running: RunningEntry[] = [];
  const waiting: TaskBoardItem[] = [];

  for (const item of items) {
    const thread = newestLiveRun(item);
    if (thread) running.push({ item, thread });
    // A card whose agent is mid-run is reported as running even if an older
    // attempt is parked on a question — one card, one place in the rail.
    else if (isTaskBlocked(item) || isTaskHandedToHuman(item))
      waiting.push(item);
  }

  running.sort(
    (a, b) =>
      Date.parse(b.thread.lastActiveAt) - Date.parse(a.thread.lastActiveAt),
  );
  waiting.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  return {
    running: running.slice(0, FEED_RAIL_LIMIT),
    waiting: waiting.slice(0, FEED_RAIL_LIMIT),
    runningTotal: running.length,
    waitingTotal: waiting.length,
  };
}

/**
 * How long something has been going, at a glance: `"3m"`, `"2h"`, `"4d"`.
 *
 * Under a minute reads `"now"` rather than `"0m"` — a run that just started has
 * not been going for no time, it has just started. Negative ages (a sandbox
 * clock ahead of this browser) clamp to the same.
 */
export function compactElapsed(iso: string, now: number): string {
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return "";
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
