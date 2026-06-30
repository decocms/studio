/**
 * Pure date / layout helpers for the Variant Calendar. Kept separate from
 * the view component so they can be unit-tested without the React tree.
 *
 * All functions are locale-independent and operate on `Date` objects in the
 * user's local timezone. `diffInDays` uses `Math.round` so DST transitions
 * (23h or 25h days) still resolve to the correct integer day count.
 */
import type { ScheduledVariant } from "./extract-variants";

export const WEEKDAYS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

export function diffInDays(a: Date, b: Date): number {
  return Math.round(
    (startOfDay(a).getTime() - startOfDay(b).getTime()) / DAY_MS,
  );
}

/**
 * 6-week (Sun → Sat) grid covering `monthStart`. Trailing weeks that fall
 * entirely in the next month are trimmed so February etc. doesn't render
 * an all-blank final row.
 */
export function buildMonthWeeks(monthStart: Date): Date[][] {
  const gridStart = addDays(monthStart, -monthStart.getDay());
  const weeks: Date[][] = [];
  for (let w = 0; w < 6; w++) {
    const days: Date[] = [];
    for (let d = 0; d < 7; d++) {
      days.push(addDays(gridStart, w * 7 + d));
    }
    weeks.push(days);
  }
  while (
    weeks.length > 0 &&
    weeks[weeks.length - 1]!.every(
      (day) => day.getMonth() !== monthStart.getMonth(),
    )
  ) {
    weeks.pop();
  }
  return weeks;
}

export interface PlacedSegment {
  variant: ScheduledVariant;
  /** 0-indexed column (0 = Sunday) where the segment starts inside the week. */
  startCol: number;
  /** Number of columns the segment spans inside the week (1..7). */
  span: number;
  /** Row within the week's stacked-bar area, assigned greedily. */
  lane: number;
}

/**
 * Greedy lane packing for one week. Each variant overlapping the week is
 * clipped to the visible Sun..Sat span and assigned to the first lane
 * whose previous segment ends at-or-before the new segment's start (so
 * a variant ending Tuesday and another starting Tuesday share a lane).
 */
export function placeWeekSegments(
  weekDays: Date[],
  variants: ScheduledVariant[],
): PlacedSegment[] {
  const weekStart = startOfDay(weekDays[0]!);
  const weekEndExclusive = addDays(weekStart, 7);
  const segments: Array<Omit<PlacedSegment, "lane">> = [];
  for (const variant of variants) {
    const vStart = startOfDay(variant.start);
    const vEnd = startOfDay(variant.end);
    if (vEnd.getTime() < weekStart.getTime()) continue;
    if (vStart.getTime() >= weekEndExclusive.getTime()) continue;
    const segStart =
      vStart.getTime() < weekStart.getTime() ? weekStart : vStart;
    const segEnd =
      vEnd.getTime() >= weekEndExclusive.getTime()
        ? addDays(weekEndExclusive, -1)
        : vEnd;
    const startCol = diffInDays(segStart, weekStart);
    const span = diffInDays(segEnd, segStart) + 1;
    if (span <= 0) continue;
    segments.push({ variant, startCol, span });
  }
  // Sort by start (ascending), then span desc (long bars take low lanes),
  // then blockKey for determinism.
  segments.sort(
    (a, b) =>
      a.startCol - b.startCol ||
      b.span - a.span ||
      a.variant.blockKey.localeCompare(b.variant.blockKey),
  );
  const laneEnds: number[] = [];
  const placed: PlacedSegment[] = [];
  for (const seg of segments) {
    let lane = laneEnds.findIndex((end) => end <= seg.startCol);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = seg.startCol + seg.span;
    placed.push({ ...seg, lane });
  }
  return placed;
}
