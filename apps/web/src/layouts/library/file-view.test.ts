import { describe, expect, test } from "bun:test";
import { matchesLibraryModified } from "./file-view";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe("matchesLibraryModified", () => {
  test("any keeps everything, including unparseable dates", () => {
    expect(matchesLibraryModified("not a date", "any", NOW)).toBe(true);
  });

  test("today is the last 24 hours, across midnight", () => {
    expect(matchesLibraryModified(hoursAgo(13), "today", NOW)).toBe(true);
    expect(matchesLibraryModified(hoursAgo(25), "today", NOW)).toBe(false);
  });

  test("week and month are rolling windows", () => {
    expect(matchesLibraryModified(hoursAgo(24 * 6), "week", NOW)).toBe(true);
    expect(matchesLibraryModified(hoursAgo(24 * 8), "week", NOW)).toBe(false);
    expect(matchesLibraryModified(hoursAgo(24 * 29), "month", NOW)).toBe(true);
    expect(matchesLibraryModified(hoursAgo(24 * 31), "month", NOW)).toBe(false);
  });

  test("an unparseable date never matches a window", () => {
    expect(matchesLibraryModified("", "week", NOW)).toBe(false);
  });
});
