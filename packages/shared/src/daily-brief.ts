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

/** A brief this many days old or older is no longer shown. */
export const MAX_BRIEF_AGE_DAYS = 7;

/** Whole days from `day` to `today`; 0 for today's brief. */
export function briefAgeDays(day: string, today: string): number {
  return Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) /
      86_400_000,
  );
}

/** The public `core` skill every brief automation follows. */
export const DAILY_BRIEF_SKILL = "/app/org/public/core/daily-brief/SKILL.md";

/** Presets the skill ships; `custom` has no validated queries. An org adds
 *  its own as `home/skills/daily-brief/<name>.md`. */
export const BRIEF_PRESETS = ["storefront", "custom"] as const;

export interface BriefSetup {
  /** A member's personal brief; null for the org's. */
  userId: string | null;
  preset: string;
  /** Connection titles the run may call; empty for all of them. */
  connections: string[];
  focus: string;
}

/** The message a brief automation sends; the skill reads these lines. */
export function briefMessage(setup: BriefSetup): string {
  const dir = setup.userId ? personalBriefDir(setup.userId) : ORG_BRIEF_DIR;
  const focus = setup.focus.trim().replace(/\s+/g, " ");
  return [
    `Build today's daily brief. Read ${DAILY_BRIEF_SKILL} first and follow it.`,
    "",
    `Scope: ${setup.userId ? `personal (user ${setup.userId})` : "org"}`,
    `Preset: ${setup.preset}`,
    `Connections: ${setup.connections.length > 0 ? setup.connections.join(", ") : "all"}`,
    `Focus: ${focus || "none"}`,
    `Write to: /app/org/home/${dir}/`,
  ].join("\n");
}

/** Daily cron, in the UTC the scheduler runs on, for `hour` o'clock in the
 *  runtime's local time zone on `now`'s date. A later DST change shifts it
 *  by an hour. */
export function briefCron(hour: number, now: Date): string {
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  return `${at.getUTCMinutes()} ${at.getUTCHours()} * * *`;
}

/** The newest brief dated between {@link MAX_BRIEF_AGE_DAYS} days ago
 *  (exclusive) and `today`. */
export function pickBrief(names: string[], today: string): BriefPick | null {
  let best: BriefPick | null = null;
  for (const name of names) {
    const day = parseBriefFilename(name);
    if (!day || (best && day <= best.day)) continue;
    const age = briefAgeDays(day, today);
    if (age >= 0 && age < MAX_BRIEF_AGE_DAYS) best = { name, day };
  }
  return best;
}
