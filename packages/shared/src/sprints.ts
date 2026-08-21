/**
 * Sprint math. Sprints are derived from the org's cadence
 * ({@link SprintConfig}) rather than stored as rows: sprint N is the Nth
 * `weeks`-long window starting at `startDate`, so a task only ever carries a
 * sprint NUMBER and changing the cadence re-labels windows instead of
 * rewriting cards.
 *
 * All day math is UTC. `startDate` is a calendar day, not an instant — reading
 * it in the viewer's zone would slide sprint boundaries by a day for anyone
 * west of UTC and make the same card read as two different sprints.
 */

import type { SprintConfig } from "./organization/schema";

export type { SprintConfig };

const DAY_MS = 86_400_000;

/** Cadence a board gets when sprints are switched on without one stored. */
export const DEFAULT_SPRINT_WEEKS = 2;

/** Selectable cadences, in weeks. */
export const SPRINT_WEEK_OPTIONS = [1, 2, 3, 4] as const;

/** UTC midnight of a `YYYY-MM-DD` day, or null when unparseable. */
function parseDay(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** `YYYY-MM-DD` of an instant, in UTC. */
export function toDayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The Monday of `date`'s week, in UTC — the default `startDate` when a team
 * turns sprints on, so sprint 1 covers the week they started rather than
 * beginning mid-week.
 */
export function mondayOfWeek(date: Date): string {
  const ms = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
  // getUTCDay: 0 = Sunday, so Sunday walks back six days, not zero.
  const weekday = new Date(ms).getUTCDay();
  const back = weekday === 0 ? 6 : weekday - 1;
  return toDayString(new Date(ms - back * DAY_MS));
}

/**
 * Which sprint `date` falls in, 1-based. Null when the cadence is unusable (a
 * malformed `startDate` or a non-positive `weeks` — either would divide the
 * calendar into windows of zero length).
 *
 * Dates before `startDate` clamp to sprint 1 rather than going negative: a
 * "sprint 0" or "sprint -3" is not a thing a team can plan into.
 */
export function sprintNumberAt(
  config: SprintConfig,
  date: Date,
): number | null {
  const start = parseDay(config.startDate);
  if (start === null || config.weeks < 1) return null;
  const windowMs = config.weeks * 7 * DAY_MS;
  const elapsed = date.getTime() - start;
  if (elapsed < 0) return 1;
  return Math.floor(elapsed / windowMs) + 1;
}

/** First and last day (`YYYY-MM-DD`, inclusive) of sprint `n`. */
export function sprintRange(
  config: SprintConfig,
  n: number,
): { start: string; end: string } | null {
  const start = parseDay(config.startDate);
  if (start === null || config.weeks < 1 || n < 1) return null;
  const windowMs = config.weeks * 7 * DAY_MS;
  const from = start + (n - 1) * windowMs;
  return {
    start: toDayString(new Date(from)),
    end: toDayString(new Date(from + windowMs - DAY_MS)),
  };
}

/**
 * The sprint numbers a picker offers: a window around the current sprint, plus
 * every sprint already in use on the board (a card parked in a long-past
 * sprint must stay selectable, and re-openable, after the board has moved on).
 *
 * Ascending, deduped, never below 1.
 */
export function sprintOptions(
  config: SprintConfig,
  now: Date,
  assigned: readonly (number | null | undefined)[] = [],
  { past = 2, future = 3 }: { past?: number; future?: number } = {},
): number[] {
  const current = sprintNumberAt(config, now);
  const numbers = new Set<number>();
  if (current !== null) {
    for (let n = current - past; n <= current + future; n++) {
      if (n >= 1) numbers.add(n);
    }
  }
  for (const n of assigned) {
    if (typeof n === "number" && n >= 1) numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b);
}
