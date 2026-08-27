/**
 * Sprints, as entities mirrored from the tracker the board syncs with (today
 * Jira, via `apps/api/src/jira/sync.ts`).
 *
 * This replaced a cadence model — sprint N = the Nth `weeks`-long window since
 * a start date, with cards carrying only the number. A real team's sprints slip,
 * get renamed, and run for different lengths, so a window could not name the
 * same sprint their board did. A sprint now carries its own name, state and
 * dates, and a card points at one.
 *
 * `state` is the tracker's, never derived from today's date: a sprint started
 * three days late is still the active one, and the board has to agree with what
 * Jira shows.
 */

/** Jira's sprint states, and ours. */
export const SPRINT_STATES = ["active", "future", "closed"] as const;

export type SprintState = (typeof SPRINT_STATES)[number];

export function isSprintState(value: unknown): value is SprintState {
  return (
    typeof value === "string" &&
    (SPRINT_STATES as readonly string[]).includes(value)
  );
}

/** A sprint as every surface reads it (tool output, board, filter). */
export interface Sprint {
  id: string;
  name: string;
  state: SprintState;
  /** ISO instants, or null — a future sprint often has no dates yet. */
  startsAt: string | null;
  endsAt: string | null;
}

const STATE_RANK: Record<SprintState, number> = {
  active: 0,
  future: 1,
  closed: 2,
};

function startTime(sprint: Sprint): number | null {
  if (!sprint.startsAt) return null;
  const ms = Date.parse(sprint.startsAt);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Reading order for a sprint list: what's running, then what's next (soonest
 * first), then history (most recent first) — Jira's own backlog ordering.
 *
 * Dateless sprints sort last within their group rather than first: a future
 * sprint nobody has scheduled yet is the least interesting thing in the list,
 * and `null` compared as 0 would put it before the Unix epoch.
 */
export function compareSprints(a: Sprint, b: Sprint): number {
  const byState = STATE_RANK[a.state] - STATE_RANK[b.state];
  if (byState !== 0) return byState;
  const aStart = startTime(a);
  const bStart = startTime(b);
  if (aStart === null || bStart === null) {
    if (aStart !== bStart) return aStart === null ? 1 : -1;
  } else if (aStart !== bStart) {
    return a.state === "closed" ? bStart - aStart : aStart - bStart;
  }
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * The sprint a board opens on: the one that is running.
 *
 * Reads the tracker's `state` rather than asking which window today falls in —
 * a sprint that started three days late is still the current one, and the board
 * has to agree with what Jira shows. Jira allows several sprints running on one
 * board, so this takes the first in reading order. Null when nothing is
 * running, which leaves the board showing every sprint.
 */
export function currentSprintId(sprints: readonly Sprint[]): string | null {
  const running = sprints
    .filter((sprint) => sprint.state === "active")
    .sort(compareSprints);
  return running[0]?.id ?? null;
}
