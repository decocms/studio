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
 * Fraction of the day already elapsed at `d`, in `[0, 1)` — e.g. noon → 0.5.
 * Clamped so DST-shortened/lengthened days (23h/25h) can't spill past the
 * day's own column when combined with the DST-correct `diffInDays`.
 */
function fractionOfDay(d: Date): number {
  const frac = (d.getTime() - startOfDay(d).getTime()) / DAY_MS;
  return Math.min(Math.max(frac, 0), 1);
}

/**
 * Position of `d` measured in day-columns from `weekStart`, carrying the
 * intra-day fraction — e.g. Tuesday 6am in a Sunday-start week → `2.25`.
 */
function unitsFromWeekStart(d: Date, weekStart: Date): number {
  return diffInDays(d, weekStart) + fractionOfDay(d);
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
  /**
   * Hour-precise left edge in day-column units from the week start, clipped
   * to the visible Sun..Sat range (0..7). Unlike `startCol` this carries the
   * intra-day fraction, so a variant starting at noon on Tuesday is `2.5`.
   * Used for horizontal rendering; `startCol`/`span` drive lane packing.
   */
  leftUnits: number;
  /** Hour-precise width in day-column units (0..7), clipped to the week. */
  widthUnits: number;
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
  const weekStartMs = weekStart.getTime();
  const weekEndMs = weekEndExclusive.getTime();
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
    // Hour-precise horizontal extent from the real timestamps, clipped to
    // the visible week. This is what makes a bar end mid-cell (e.g. a
    // campaign ending 10am shows ~40% into its last day) instead of
    // filling whole day columns like `startCol`/`span` do.
    const leftMs = Math.max(variant.start.getTime(), weekStartMs);
    const rightMs = Math.min(variant.end.getTime(), weekEndMs);
    const leftUnits = unitsFromWeekStart(new Date(leftMs), weekStart);
    const widthUnits = Math.max(
      unitsFromWeekStart(new Date(rightMs), weekStart) - leftUnits,
      0,
    );
    // A zero-width visual (e.g. a campaign ending exactly at this week's
    // Sunday 00:00, already over) must not render — otherwise `minWidth`
    // would paint a stray sliver on a week the variant doesn't cover.
    if (widthUnits <= 0) continue;
    segments.push({ variant, startCol, span, leftUnits, widthUnits });
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
