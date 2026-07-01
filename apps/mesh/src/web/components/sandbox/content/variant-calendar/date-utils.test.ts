import { describe, expect, it } from "bun:test";
import {
  addDays,
  addMonths,
  buildMonthWeeks,
  diffInDays,
  placeWeekSegments,
  startOfDay,
  startOfMonth,
} from "./date-utils";
import type { ScheduledVariant } from "./extract-variants";

function makeVariant(
  start: string,
  end: string,
  blockKey = "Block",
): ScheduledVariant {
  return {
    blockKey,
    blockLabel: blockKey,
    innerPath: "",
    variantIndex: 0,
    start: new Date(start),
    end: new Date(end),
    openStart: false,
    openEnd: false,
    label: blockKey,
    flagResolveType: "website/flags/multivariate/section.ts",
  };
}

describe("startOfDay / startOfMonth / addMonths / addDays", () => {
  it("startOfDay zeroes the time portion without mutating the input", () => {
    const input = new Date("2026-06-15T13:45:30.500");
    const out = startOfDay(input);
    expect(out.getHours()).toBe(0);
    expect(out.getMinutes()).toBe(0);
    expect(out.getSeconds()).toBe(0);
    expect(out.getMilliseconds()).toBe(0);
    // Input untouched.
    expect(input.getHours()).toBe(13);
  });

  it("startOfMonth returns the first day at midnight local", () => {
    const out = startOfMonth(new Date(2026, 5, 17));
    expect(out.getFullYear()).toBe(2026);
    expect(out.getMonth()).toBe(5);
    expect(out.getDate()).toBe(1);
  });

  it("addMonths normalizes to the first of the target month", () => {
    expect(addMonths(new Date(2026, 0, 31), 1).getMonth()).toBe(1);
    expect(addMonths(new Date(2026, 11, 1), 1).getFullYear()).toBe(2027);
    expect(addMonths(new Date(2026, 0, 1), -1).getFullYear()).toBe(2025);
  });

  it("addDays handles month rollover", () => {
    const out = addDays(new Date(2026, 0, 31), 1);
    expect(out.getMonth()).toBe(1);
    expect(out.getDate()).toBe(1);
  });
});

describe("diffInDays", () => {
  it("returns whole days between two dates regardless of clock time", () => {
    expect(
      diffInDays(new Date("2026-06-15T23:59:59"), new Date("2026-06-15")),
    ).toBe(0);
    expect(
      diffInDays(new Date("2026-06-16T00:00:01"), new Date("2026-06-15")),
    ).toBe(1);
    expect(diffInDays(new Date("2026-06-15"), new Date("2026-06-16"))).toBe(-1);
  });

  it("crosses a DST spring-forward without losing a day (US locale)", () => {
    // US DST starts 2026-03-08. Without rounding, 7 days * 86_400_000 ms
    // would drop to 6.96, which floor()/trunc() would round to 6. We use
    // Math.round so DST is absorbed correctly.
    const a = new Date(2026, 2, 1);
    const b = new Date(2026, 2, 8);
    expect(diffInDays(b, a)).toBe(7);
  });
});

describe("buildMonthWeeks", () => {
  it("starts every week on Sunday", () => {
    const weeks = buildMonthWeeks(new Date(2026, 5, 1));
    for (const week of weeks) {
      expect(week[0]!.getDay()).toBe(0);
      expect(week).toHaveLength(7);
    }
  });

  it("the very first day is on or before monthStart", () => {
    const monthStart = new Date(2026, 5, 1);
    const weeks = buildMonthWeeks(monthStart);
    expect(weeks[0]![0]!.getTime()).toBeLessThanOrEqual(monthStart.getTime());
  });

  it("trims trailing weeks that fall entirely in the next month", () => {
    // Feb 2026: starts Sunday, ends Saturday — fits in 4 weeks → trim 2.
    const weeks = buildMonthWeeks(new Date(2026, 1, 1));
    expect(weeks.length).toBeGreaterThanOrEqual(4);
    expect(weeks.length).toBeLessThanOrEqual(6);
    for (const week of weeks) {
      const someInMonth = week.some((d) => d.getMonth() === 1);
      expect(someInMonth).toBe(true);
    }
  });

  it("includes weeks containing leading next-month days when the month spills", () => {
    // June 2026 starts on Monday and ends on Tuesday — the last visible
    // week must include 2026-06-30, even though most of it is July.
    const weeks = buildMonthWeeks(new Date(2026, 5, 1));
    const lastWeek = weeks[weeks.length - 1]!;
    expect(lastWeek.some((d) => d.getMonth() === 5)).toBe(true);
  });
});

describe("placeWeekSegments", () => {
  const week = buildMonthWeeks(new Date(2026, 5, 7))[0]!; // Sun 2026-06-07

  it("clips a variant to the week and assigns lane 0 when alone", () => {
    const placed = placeWeekSegments(week, [
      makeVariant("2026-06-01T00:00:00", "2026-06-09T23:59:59"),
    ]);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ startCol: 0, span: 3, lane: 0 });
  });

  it("separates overlapping variants into distinct lanes", () => {
    const placed = placeWeekSegments(week, [
      makeVariant("2026-06-08T00:00:00", "2026-06-10T23:59:59", "A"),
      makeVariant("2026-06-09T00:00:00", "2026-06-11T23:59:59", "B"),
    ]);
    expect(placed).toHaveLength(2);
    const lanes = placed.map((p) => p.lane).sort();
    expect(lanes).toEqual([0, 1]);
  });

  it("reuses a lane when one segment ends before the next starts", () => {
    // A: Mon..Tue, B: Wed..Thu — no overlap; both should sit on lane 0.
    const placed = placeWeekSegments(week, [
      makeVariant("2026-06-08T00:00:00", "2026-06-09T23:59:59", "A"),
      makeVariant("2026-06-10T00:00:00", "2026-06-11T23:59:59", "B"),
    ]);
    expect(placed).toHaveLength(2);
    for (const p of placed) expect(p.lane).toBe(0);
  });

  it("skips variants outside the week", () => {
    const placed = placeWeekSegments(week, [
      makeVariant("2026-05-01T00:00:00", "2026-05-15T00:00:00"),
      makeVariant("2026-07-01T00:00:00", "2026-07-15T00:00:00"),
    ]);
    expect(placed).toEqual([]);
  });

  it("sorts ties deterministically by blockKey", () => {
    const placed = placeWeekSegments(week, [
      makeVariant("2026-06-08T00:00:00", "2026-06-09T23:59:59", "Z-block"),
      makeVariant("2026-06-08T00:00:00", "2026-06-09T23:59:59", "A-block"),
    ]);
    // Two segments at same start+span → A-block takes the lower lane (0).
    const aSeg = placed.find((p) => p.variant.blockKey === "A-block");
    const zSeg = placed.find((p) => p.variant.blockKey === "Z-block");
    expect(aSeg?.lane).toBe(0);
    expect(zSeg?.lane).toBe(1);
  });

  it("carries hour-precise fractional extent (ending mid-day)", () => {
    // Sun 2026-06-07 week. Ends noon on the 9th → last day only half-filled,
    // even though the whole-day `span` still counts the 9th as covered.
    const placed = placeWeekSegments(week, [
      makeVariant("2026-06-07T00:00:00", "2026-06-09T12:00:00"),
    ]);
    expect(placed[0]?.span).toBe(3);
    expect(placed[0]?.leftUnits).toBe(0);
    expect(placed[0]?.widthUnits).toBeCloseTo(2.5, 5);
  });

  it("reflects a mid-day start and end within a single day", () => {
    // Mon 2026-06-08, 6am → 6pm: column 1, quarter-in, half-a-day wide.
    const placed = placeWeekSegments(week, [
      makeVariant("2026-06-08T06:00:00", "2026-06-08T18:00:00"),
    ]);
    expect(placed[0]?.leftUnits).toBeCloseTo(1.25, 5);
    expect(placed[0]?.widthUnits).toBeCloseTo(0.5, 5);
  });

  it("clips fractional extent to the visible week", () => {
    // Spans well before and after the week → full 0..7 width, no overflow.
    const placed = placeWeekSegments(week, [
      makeVariant("2026-06-01T00:00:00", "2026-06-20T00:00:00"),
    ]);
    expect(placed[0]?.leftUnits).toBe(0);
    expect(placed[0]?.widthUnits).toBe(7);
  });

  it("clamps the left edge but keeps a fractional right edge", () => {
    // Starts before the week (left clamped to 0), ends 6am on the 9th →
    // widthUnits 2.25, distinct from the whole-day span of 3.
    const placed = placeWeekSegments(week, [
      makeVariant("2026-06-01T00:00:00", "2026-06-09T06:00:00"),
    ]);
    expect(placed[0]?.span).toBe(3);
    expect(placed[0]?.leftUnits).toBe(0);
    expect(placed[0]?.widthUnits).toBeCloseTo(2.25, 5);
  });

  it("skips a zero-width segment ending exactly at the week's start", () => {
    // Campaign already over by Sunday 00:00 — must not render a `minWidth`
    // sliver on this week (regression guard for the ghost-bar bug).
    const placed = placeWeekSegments(week, [
      makeVariant("2026-06-01T00:00:00", "2026-06-07T00:00:00"),
    ]);
    expect(placed).toEqual([]);
  });
});
