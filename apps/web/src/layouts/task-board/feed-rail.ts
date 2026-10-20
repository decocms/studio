/**
 * What belongs beside the feed: what an agent is doing this second, and what
 * has stopped on a person. Derived from the board the feed already loaded, so
 * the rail cannot disagree with the rows beside it.
 */

import {
  isLiveAttempt,
  isTaskBlocked,
  isTaskHandedToHuman,
  type TaskBoardItem,
  type TaskBoardItemThread,
} from "./config";

/** Past a handful the rail competes with the feed beside it. */
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
    // One card, one place: a live run outranks an older parked attempt.
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

/** `"3m"`, `"2h"`, `"4d"`. Under a minute — and a negative age from sandbox
 *  clock skew — reads `"now"`, not `"0m"`. */
export function compactElapsed(iso: string, now: number): string {
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return "";
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
