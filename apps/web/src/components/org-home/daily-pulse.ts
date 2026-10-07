/**
 * The org home's numbers, read out of the board payload it already loads.
 * Nothing here fetches; all of it is pure so the counts can be tested.
 */

import {
  isTaskBlocked,
  isTaskHandedToHuman,
  type TaskBoardItem,
} from "@/layouts/task-board/config";
import { projectsForTask, type ProjectIndex } from "@/lib/project-index";

/** The window "this week" means, in days. */
const PULSE_WINDOW_DAYS = 7;

/** Lanes that mean the work left the board on its own feet. `archived` is not
 *  one of them: a cancelled card did not ship. */
const SHIPPED = new Set<TaskBoardItem["status"]>(["done", "merged"]);

/** Lanes where nothing more will happen, so the card is not "open". */
const CLOSED = new Set<TaskBoardItem["status"]>(["done", "merged", "archived"]);

const WINDOW_MS = PULSE_WINDOW_DAYS * 86_400_000;

/** Age is clamped at zero so sandbox/browser clock skew cannot push a
 *  just-finished run outside the window. */
function withinWindow(iso: string | null | undefined, now: number): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return false;
  return Math.max(0, now - at) <= WINDOW_MS;
}

/** Cards that reached `done` or `merged` at or after `since` (epoch ms). The
 *  brief's window is the slot's, not a week: see `pulseWindowStart`. */
export function shippedSince(
  tasks: readonly TaskBoardItem[],
  since: number,
): number {
  let shipped = 0;
  for (const task of tasks) {
    if (!SHIPPED.has(task.status) || !task.updatedAt) continue;
    const at = Date.parse(task.updatedAt);
    if (!Number.isNaN(at) && at >= since) shipped++;
  }
  return shipped;
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

/** One project's week as ONE headline, ranked waiting › failed › shipped ›
 *  open. The ranking is the feature, hence the test. */
export type ProjectHeadlineKind =
  | "waiting"
  | "failed"
  | "shipped"
  | "open"
  | "quiet";

export interface ProjectSummary {
  kind: ProjectHeadlineKind;
  /** The number the headline is about. Zero only for `quiet`. */
  count: number;
  /** Open cards, whatever the headline says — the row's constant column. */
  open: number;
}

export function projectSummaries(
  index: ProjectIndex,
  tasks: readonly TaskBoardItem[],
  userId: string | undefined,
  now: number = Date.now(),
): Map<string, ProjectSummary> {
  const waiting = new Set(tasksNeedingMe(tasks, userId).map((task) => task.id));
  const tally = new Map<
    string,
    { waiting: number; failed: number; shipped: number; open: number }
  >();

  const bump = (
    projectId: string,
    key: "waiting" | "failed" | "shipped" | "open",
  ) => {
    const current = tally.get(projectId) ?? {
      waiting: 0,
      failed: 0,
      shipped: 0,
      open: 0,
    };
    current[key] += 1;
    tally.set(projectId, current);
  };

  for (const task of tasks) {
    const closed = CLOSED.has(task.status);
    const failed = task.threads.some(
      (thread) =>
        thread.status === "failed" && withinWindow(thread.lastActiveAt, now),
    );
    const shipped =
      SHIPPED.has(task.status) && withinWindow(task.updatedAt, now);
    for (const project of projectsForTask(task, index)) {
      if (!closed) bump(project.id, "open");
      if (waiting.has(task.id)) bump(project.id, "waiting");
      if (failed) bump(project.id, "failed");
      if (shipped) bump(project.id, "shipped");
    }
  }

  const summaries = new Map<string, ProjectSummary>();
  for (const [projectId, counts] of tally) {
    const kind: ProjectHeadlineKind = counts.waiting
      ? "waiting"
      : counts.failed
        ? "failed"
        : counts.shipped
          ? "shipped"
          : counts.open
            ? "open"
            : "quiet";
    summaries.set(projectId, {
      kind,
      count: kind === "quiet" ? 0 : counts[kind],
      open: counts.open,
    });
  }
  return summaries;
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
  index: ProjectIndex,
  tasks: readonly TaskBoardItem[],
  projectId: string,
  days: number,
  now: number = Date.now(),
): number[] {
  const series = new Array<number>(days).fill(0);
  for (const task of tasks) {
    if (!SHIPPED.has(task.status) || !task.updatedAt) continue;
    if (!projectsForTask(task, index).some((p) => p.id === projectId)) continue;
    const at = Date.parse(task.updatedAt);
    if (Number.isNaN(at)) continue;
    const dayIndex = days - 1 - Math.floor(Math.max(0, now - at) / 86_400_000);
    if (dayIndex >= 0 && dayIndex < days) series[dayIndex]! += 1;
  }
  return series;
}

/** Runs today, and how many are still going. Today rather than the seven-day
 *  window: this answers "is the machine running right now". */
export interface RunsToday {
  runs: number;
  live: number;
}

export function runsToday(
  tasks: readonly TaskBoardItem[],
  now: number = Date.now(),
): RunsToday {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const since = startOfDay.getTime();
  let runs = 0;
  let live = 0;
  for (const task of tasks) {
    for (const thread of task.threads) {
      if (thread.status === "in_progress") live++;
      const at = Date.parse(thread.lastActiveAt);
      if (!Number.isNaN(at) && at >= since) runs++;
    }
  }
  return { runs, live };
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

/** The one month-to-date window {@link monthlyCost} and the cost chart both
 *  bucket against, so headline and chart cannot drift apart. */
function monthToDateWindow(now: number): { since: number; days: number } {
  const start = new Date(now);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const since = start.getTime();
  return { since, days: Math.floor((now - since) / 86_400_000) + 1 };
}

/** Dollars per calendar day since the 1st, oldest first — {@link costSeries}'s
 *  month-to-date sibling, for a chart under a "this month" headline. */
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
      const index = Math.floor((at - since) / 86_400_000);
      if (index >= 0 && index < days) series[index]! += thread.costUsd ?? 0;
    }
  }
  return series;
}

/** {@link costSeriesMonthToDate}, scoped to one project. */
export function costSeriesForProjectMonthToDate(
  index: ProjectIndex,
  tasks: readonly TaskBoardItem[],
  projectId: string,
  now: number = Date.now(),
): number[] {
  const { since, days } = monthToDateWindow(now);
  const series = new Array<number>(days).fill(0);
  for (const task of tasks) {
    if (!projectsForTask(task, index).some((p) => p.id === projectId)) continue;
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

/** Agent spend this calendar month — the unit a bill arrives in. A provider
 *  that reports no cost adds a run but no dollars. */
export interface MonthlyCost {
  total: number;
  /** Per project id, highest first. Only projects that spent anything. */
  byProject: { projectId: string; usd: number }[];
  /** Dollars per card shipped, or null when nothing shipped. */
  perShipped: number | null;
}

export function monthlyCost(
  index: ProjectIndex,
  tasks: readonly TaskBoardItem[],
  now: number = Date.now(),
): MonthlyCost {
  const { since } = monthToDateWindow(now);
  const within = (iso: string | null | undefined) => {
    if (!iso) return false;
    const at = Date.parse(iso);
    return !Number.isNaN(at) && at >= since && at <= now;
  };

  let total = 0;
  let shipped = 0;
  const perProject = new Map<string, number>();
  for (const task of tasks) {
    if (SHIPPED.has(task.status) && within(task.updatedAt)) shipped++;
    let taskCost = 0;
    for (const thread of task.threads) {
      if (within(thread.lastActiveAt)) taskCost += thread.costUsd ?? 0;
    }
    if (taskCost === 0) continue;
    total += taskCost;
    for (const project of projectsForTask(task, index)) {
      perProject.set(project.id, (perProject.get(project.id) ?? 0) + taskCost);
    }
  }

  return {
    total,
    byProject: [...perProject]
      .map(([projectId, usd]) => ({ projectId, usd }))
      .sort((a, b) => b.usd - a.usd),
    perShipped: shipped > 0 ? total / shipped : null,
  };
}
