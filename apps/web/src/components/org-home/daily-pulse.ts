/**
 * The org home's numbers, read out of the board payload it already loads.
 * Nothing here fetches; all of it is pure so the counts can be tested.
 */

import {
  isTaskBlocked,
  isTaskHandedToHuman,
  type TaskBoardItem,
} from "@/layouts/task-board/config";

/** Lanes that mean the work left the board on its own feet: merged and in
 *  production, whether or not someone has confirmed it there yet. `archived`
 *  is not one of them: a cancelled card did not ship. */
const SHIPPED = new Set<TaskBoardItem["status"]>([
  "post_deploy_validation",
  "done",
]);

/** Lanes where nothing more will happen, so the card is not "open".
 *  `post_deploy_validation` shipped but is still open: someone has to confirm
 *  it works in production. */
const CLOSED = new Set<TaskBoardItem["status"]>(["done", "archived"]);

/** When a card shipped, or null if it has not. The board has no ship time, so
 *  its last update in a shipped lane stands in for one. */
function shippedAt(task: TaskBoardItem): number | null {
  if (!SHIPPED.has(task.status) || !task.updatedAt) return null;
  const at = Date.parse(task.updatedAt);
  return Number.isNaN(at) ? null : at;
}

/** Cards that shipped at or after `since`. */
export function shippedSince(
  tasks: readonly TaskBoardItem[],
  since: number,
): number {
  return tasks.filter((task) => (shippedAt(task) ?? -Infinity) >= since).length;
}

/** Cards stopped on a person, OLDEST first — a queue, not a feed. Blocked and
 *  handed-to-human cards are here because neither shows in an assignee
 *  filter. */
export function tasksNeedingMe(
  tasks: readonly TaskBoardItem[],
  userId: string | undefined,
): TaskBoardItem[] {
  return tasks
    .filter((task) => {
      if (CLOSED.has(task.status)) return false;
      if (userId && task.assigneeId === userId) return true;
      return isTaskBlocked(task) || isTaskHandedToHuman(task);
    })
    .sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));
}

/** Why a card is in the list. No `userId`: `tasksNeedingMe` already decided,
 *  so anything else is here because it is assigned to the reader. */
export type AttentionReason = "answer" | "review" | "assigned";

export function attentionReason(task: TaskBoardItem): AttentionReason {
  if (isTaskBlocked(task)) return "answer";
  if (isTaskHandedToHuman(task)) return "review";
  return "assigned";
}

/** The runs happening right now, newest first — `in_progress` threads already
 *  in the board payload. */
export interface RunningAgent {
  threadId: string;
  taskId: string;
  taskTitle: string;
  /** The run's own title when it has one — what the agent says it is doing. */
  runTitle: string | null;
  startedAt: string;
}

export function runningAgents(tasks: readonly TaskBoardItem[]): RunningAgent[] {
  const running: RunningAgent[] = [];
  for (const task of tasks) {
    for (const thread of task.threads) {
      if (thread.status !== "in_progress") continue;
      running.push({
        threadId: thread.threadId,
        taskId: task.id,
        taskTitle: task.title,
        runTitle: thread.title,
        startedAt: thread.createdAt,
      });
    }
  }
  return running.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Cards shipped per day for one project, oldest first — delivery rhythm, not
 *  a business metric (see `project-profile.ts`). */
/** Two weeks: one has no shape, a month is noise at 56px. */
export const RHYTHM_DAYS = 14;

export function shippedSeries(
  tasks: readonly TaskBoardItem[],
  days: number,
  now: number = Date.now(),
): number[] {
  const series = new Array<number>(days).fill(0);
  for (const task of tasks) {
    const at = shippedAt(task);
    if (at === null) continue;
    const dayIndex = days - 1 - Math.floor(Math.max(0, now - at) / 86_400_000);
    if (dayIndex >= 0 && dayIndex < days) series[dayIndex]! += 1;
  }
  return series;
}

/** Runs per day, oldest first — the shape the runs sparkline draws. */
export function runsSeries(
  tasks: readonly TaskBoardItem[],
  days: number,
  now: number = Date.now(),
): number[] {
  const series = new Array<number>(days).fill(0);
  for (const task of tasks) {
    for (const thread of task.threads) {
      const at = Date.parse(thread.lastActiveAt);
      if (Number.isNaN(at)) continue;
      const index = days - 1 - Math.floor(Math.max(0, now - at) / 86_400_000);
      if (index >= 0 && index < days) series[index]! += 1;
    }
  }
  return series;
}

/** Day 1 of this month to today. */
function monthToDateWindow(now: number): { since: number; days: number } {
  const start = new Date(now);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const since = start.getTime();
  return { since, days: Math.floor((now - since) / 86_400_000) + 1 };
}

/** Dollars per calendar day since the 1st, oldest first. */
export function costSeriesMonthToDate(
  tasks: readonly TaskBoardItem[],
  now: number = Date.now(),
): number[] {
  const { since, days } = monthToDateWindow(now);
  const series = new Array<number>(days).fill(0);
  for (const task of tasks) {
    for (const thread of task.threads) {
      const at = Date.parse(thread.lastActiveAt);
      if (Number.isNaN(at) || at < since || at > now) continue;
      const dayIndex = Math.floor((at - since) / 86_400_000);
      if (dayIndex >= 0 && dayIndex < days)
        series[dayIndex]! += thread.costUsd ?? 0;
    }
  }
  return series;
}

/** `$1.2k`, `$318`, `$8.97` — magnitude, never cents on a four-figure number.
 *  Nothing spent is `$0`, not `$0.00`. */
export function formatUsd(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`;
  if (usd >= 10) return `$${Math.round(usd)}`;
  return `$${usd.toFixed(2)}`;
}
