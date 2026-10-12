/** How a sprint reads in pickers, chips and the card pill. */

import type { Sprint } from "@decocms/shared/sprints";
import type { TFunction } from "@/i18n/use-t.ts";

/** UTC on both ends: a sprint's days are calendar days, and formatting them
 *  in a timezone west of UTC would print the day before. */
const DAY_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function formatDay(day: string): string {
  return DAY_FMT.format(new Date(`${day}T00:00:00Z`));
}

/** `Mar 2 – Mar 15`, one end alone when only one is set, or null when the
 *  sprint has no dates yet. */
export function formatSprintDays(
  sprint: Pick<Sprint, "startDate" | "endDate">,
): string | null {
  const start = sprint.startDate ? formatDay(sprint.startDate) : null;
  const end = sprint.endDate ? formatDay(sprint.endDate) : null;
  if (start && end) return `${start} – ${end}`;
  return start ?? end;
}

/** The sprint's name, marked when it is the one running. */
export function sprintLabel(sprint: Sprint, t: TFunction): string {
  return sprint.state === "active"
    ? t("taskBoard.sprints.nameCurrent", { name: sprint.name })
    : sprint.state === "closed"
      ? t("taskBoard.sprints.nameClosed", { name: sprint.name })
      : sprint.name;
}
