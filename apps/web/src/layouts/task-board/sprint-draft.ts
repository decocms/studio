/** What the "New sprint" form starts with, so planning the usual next sprint
 *  is one click. */

import type { Sprint } from "@decocms/shared/sprints";

/** Two weeks, counted inclusively: Mar 2 – Mar 15. */
const DEFAULT_LENGTH_DAYS = 14;

const NUMBERED = /^sprint\s+(\d+)$/i;

function addDays(day: string, days: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * `Sprint N+1` after the highest numbered sprint, starting the day after the
 * latest end date (or `today`, when that is later or no sprint has dates).
 */
export function suggestNextSprint(
  sprints: readonly Sprint[],
  today: string,
): { name: string; startDate: string; endDate: string } {
  const highest = Math.max(
    0,
    ...sprints.map((sprint) =>
      Number(NUMBERED.exec(sprint.name.trim())?.[1] ?? 0),
    ),
  );
  const lastEnd = sprints
    .map((sprint) => sprint.endDate)
    .filter((day): day is string => day !== null)
    .sort()
    .at(-1);
  const afterLast = lastEnd ? addDays(lastEnd, 1) : today;
  const startDate = afterLast > today ? afterLast : today;
  return {
    name: `Sprint ${highest > 0 ? highest + 1 : sprints.length + 1}`,
    startDate,
    endDate: addDays(startDate, DEFAULT_LENGTH_DAYS - 1),
  };
}

/** Today in the viewer's own calendar, as `YYYY-MM-DD`. */
export function localToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
