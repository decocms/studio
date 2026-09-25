/**
 * The numbers an operator opens Studio to check.
 *
 * A storefront team does not come here to browse a list of projects — they come
 * to find out what the agents did overnight, whether anything broke, and what is
 * stopped waiting on them. All three answers are already in the board the home
 * loads, so this module reads them out of it and nothing new is fetched.
 *
 * Pure, and exported for its test: every one of these numbers is a claim about
 * someone's store, and a count that is quietly wrong is worse than no count.
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

/**
 * The two counts the brief's sentence is made of.
 *
 * It used to carry four, plus each one's value a week earlier, for a strip of
 * numbers under the headline. The strip is gone: the sentence already says what
 * shipped and what broke, and a row restating both in digits was the same news
 * twice. Nothing reads the rest, so nothing computes it.
 */
export interface DailyPulse {
  /** Reached `done` or `merged` inside the window. */
  shipped: number;
  /** A run failed inside the window. */
  failed: number;
}

const WINDOW_MS = PULSE_WINDOW_DAYS * 86_400_000;

/**
 * Whether a timestamp falls inside the window ending now.
 *
 * Ages are clamped at zero so a run that finished this instant counts, and so
 * does one whose timestamp is slightly in the future — clock skew between a
 * sandbox and this browser is routine, and an unclamped age put those outside
 * every window.
 */
function withinWindow(iso: string | null | undefined, now: number): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return false;
  return Math.max(0, now - at) <= WINDOW_MS;
}

export function dailyPulse(
  tasks: readonly TaskBoardItem[],
  now: number = Date.now(),
): DailyPulse {
  let shipped = 0;
  let failed = 0;
  for (const task of tasks) {
    if (SHIPPED.has(task.status) && withinWindow(task.updatedAt, now))
      shipped++;
    if (
      task.threads.some(
        (thread) =>
          thread.status === "failed" && withinWindow(thread.lastActiveAt, now),
      )
    ) {
      failed++;
    }
  }
  return { shipped, failed };
}

/**
 * The cards stopped waiting on a person, OLDEST first.
 *
 * A queue, not a feed. The card that has been waiting longest is the one most
 * likely to have been forgotten, and sorting newest-first buries it under
 * whatever arrived this morning — which is how a hand-off nobody caught stays
 * uncaught.
 *
 * Three ways in, and the two that are not "assigned to me" are the ones worth
 * having: a run that called `user_ask` is stopped until someone answers, and a
 * card parked In Review with no assignee is a hand-off nobody caught. Neither
 * shows up in an assignee filter, which is exactly why they get missed.
 */
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

/** Why a card is in the list, so the row can say it rather than just list it.
 *  No `userId`: `tasksNeedingMe` already decided the card belongs here, so
 *  anything that is neither a question nor an unowned review is here because it
 *  is assigned to the reader. */
export type AttentionReason = "answer" | "review" | "assigned";

export function attentionReason(task: TaskBoardItem): AttentionReason {
  if (isTaskBlocked(task)) return "answer";
  if (isTaskHandedToHuman(task)) return "review";
  return "assigned";
}

/**
 * One project's week, for the org home's roster.
 *
 * The org home is navigation, so each row has to answer "is there anything for
 * me in here" before you click it. Four counts is not that answer — it is the
 * same reading work, done five times down a column. So the row gets ONE
 * headline, ranked by how much it wants you: something stopped on you beats
 * something that broke, which beats something that shipped, which beats a
 * queue that is merely open.
 *
 * Pure, and exported for its test: the ranking IS the feature, and a row that
 * says "3 shipped" while a run is waiting on an answer is a row that cost
 * someone their morning.
 */
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

/**
 * The runs happening right now, newest first.
 *
 * A dashboard that only reports finished work reads as a log. This is the one
 * section that says the product is doing something while you look at it, and it
 * is free: `in_progress` threads are already in the board payload.
 */
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

/**
 * Cards shipped per day for one project, oldest day first.
 *
 * The shape a sparkline draws. Deliberately NOT a business metric: a project
 * does not declare a goal anywhere in this product, and inventing a field to
 * hold one is the mistake `project-profile.ts` exists to prevent. What a
 * project provably has is a delivery rhythm, and a flat line on a storefront
 * that used to ship every day is a real thing to notice.
 */
/** How wide a project's rhythm line is. Two weeks: one is too short to have a
 *  shape, and a month compresses a daily bar into noise at 56 pixels. */
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

/**
 * Runs today, and how many are still going.
 *
 * "Today" and not the seven-day window on purpose: this is the number an
 * operator checks to know whether the machine is running right now, and a
 * weekly total answers a different question. Both come off threads the board
 * already carries, so neither adds a read.
 */
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

/** The 1st of `now`'s calendar month at local midnight, and how many calendar
 *  days stand between it and `now` (inclusive) — the one window definition
 *  {@link monthlyCost} and the cost drill-down's daily series both bucket
 *  against, so a headline reading "this month" and the chart under it are
 *  never quietly two different windows. */
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

/**
 * What the agents have cost this calendar month, and which projects spent it.
 *
 * Calendar month rather than a rolling window because that is the unit a bill
 * arrives in, and someone checking spend is checking it against an invoice.
 * A provider that reports no cost contributes a run but no dollars, so the
 * total can be zero while the runs are not — which is true, and better than
 * inventing an estimate.
 */
export interface MonthlyCost {
  total: number;
  /** Per project id, highest first. Only projects that spent anything. */
  byProject: { projectId: string; usd: number }[];
  /** Dollars per card shipped this month, or null when nothing shipped — a
   *  ratio with a zero denominator is not a number anyone should read. */
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
