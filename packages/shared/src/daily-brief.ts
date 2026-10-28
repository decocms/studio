/**
 * Where daily briefs live in the org filesystem and which one a reader sees.
 * The home reads them; whatever writes them imports the same paths.
 *
 * Both sit in the `home` volume: the org's brief in `brief/`, a member's own
 * in `users/<userId>/brief/`, which only that member can read. A brief is one
 * HTML file named after the day it covers, `<YYYY-MM-DD>.html`.
 */

import { isCalendarDay } from "./sprints";

export const DAILY_BRIEF_VOLUME = "home";

export const ORG_BRIEF_DIR = "brief";

export function personalBriefDir(userId: string): string {
  return `users/${userId}/brief`;
}

export function briefPath(dir: string, day: string): string {
  return `${dir}/${day}.html`;
}

/** `YYYY-MM-DD` of `date` in the runtime's local time zone. */
export function briefDay(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The day a brief filename covers, or null when the name is not a real
 *  calendar date followed by `.html`. */
export function parseBriefFilename(name: string): string | null {
  if (!name.endsWith(".html")) return null;
  const day = name.slice(0, -".html".length);
  return isCalendarDay(day) ? day : null;
}

export interface BriefPick {
  /** Filename inside the brief folder. */
  name: string;
  day: string;
}

/** The newest brief that is not dated after `today`. ISO days sort as
 *  strings, so no date math is needed. */
export function pickBrief(names: string[], today: string): BriefPick | null {
  let best: BriefPick | null = null;
  for (const name of names) {
    const day = parseBriefFilename(name);
    if (day && day <= today && (!best || day > best.day)) best = { name, day };
  }
  return best;
}

/** Whole days from `day` to `today`; 0 for today's brief. */
export function briefAgeDays(day: string, today: string): number {
  return Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) /
      86_400_000,
  );
}
