/**
 * Sprints the task board owns: a named, dated window a card can be planned
 * into. A card with no sprint is in the backlog.
 *
 * `state` is set by people, never derived from today's date. A sprint started
 * three days late is still the running one, and a sprint nobody closed has
 * not ended just because its end date passed.
 */

export const SPRINT_STATES = ["future", "active", "closed"] as const;

export type SprintState = (typeof SPRINT_STATES)[number];

/** No real sprint name is this long; it is a label, like a tag's. */
export const MAX_SPRINT_NAME_LENGTH = 100;

/** A sprint as every surface reads it (tool output, board, filter). */
export interface Sprint {
  id: string;
  name: string;
  state: SprintState;
  /** Calendar days (`YYYY-MM-DD`), or null for a sprint not scheduled yet. */
  startDate: string | null;
  endDate: string | null;
}

/**
 * The lanes a card has finished in. Completing a sprint leaves these cards in
 * it as its record and moves every other card on to the next one.
 */
export const FINISHED_STATUSES: readonly string[] = ["done", "archived"];

export function isFinishedStatus(status: string): boolean {
  return FINISHED_STATUSES.includes(status);
}

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True for a real `YYYY-MM-DD` day. `Date.parse` rolls an out-of-range day
 * over instead of failing (`2026-02-31` reads as March 3), so the parse is
 * round-tripped.
 */
export function isCalendarDay(value: string): boolean {
  if (!CALENDAR_DAY.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

const STATE_RANK: Record<SprintState, number> = {
  active: 0,
  future: 1,
  closed: 2,
};

/**
 * Reading order for a sprint list: what is running, then what is next
 * (soonest first), then history (most recent first).
 *
 * Unscheduled sprints sort last within their group: a future sprint nobody
 * has dated yet is the least pressing thing in the list. `YYYY-MM-DD` strings
 * compare in calendar order, so no parsing is needed.
 */
export function compareSprints(a: Sprint, b: Sprint): number {
  const byState = STATE_RANK[a.state] - STATE_RANK[b.state];
  if (byState !== 0) return byState;
  if (a.startDate !== b.startDate) {
    if (a.startDate === null) return 1;
    if (b.startDate === null) return -1;
    const byStart = a.startDate < b.startDate ? -1 : 1;
    return a.state === "closed" ? -byStart : byStart;
  }
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * The sprint a board opens on: the first running one in reading order. Null
 * when nothing is running, which leaves the board showing every card.
 */
export function currentSprintId(sprints: readonly Sprint[]): string | null {
  return (
    [...sprints]
      .filter((sprint) => sprint.state === "active")
      .sort(compareSprints)[0]?.id ?? null
  );
}

/**
 * Where a completed sprint's unfinished cards go by default: the soonest
 * planned sprint. Null when none is planned, which sends them to the backlog.
 */
export function nextSprintId(
  sprints: readonly Sprint[],
  completingId: string,
): string | null {
  return (
    [...sprints]
      .filter(
        (sprint) => sprint.state === "future" && sprint.id !== completingId,
      )
      .sort(compareSprints)[0]?.id ?? null
  );
}
