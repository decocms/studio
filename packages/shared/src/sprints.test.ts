import { describe, expect, it } from "bun:test";
import {
  mondayOfWeek,
  sprintNumberAt,
  sprintOptions,
  sprintRange,
  type SprintConfig,
} from "./sprints";

const CONFIG: SprintConfig = {
  enabled: true,
  weeks: 2,
  startDate: "2026-01-05", // a Monday
};

describe("sprintNumberAt", () => {
  it("counts 1-based windows from startDate", () => {
    expect(sprintNumberAt(CONFIG, new Date("2026-01-05T00:00:00Z"))).toBe(1);
    expect(sprintNumberAt(CONFIG, new Date("2026-01-18T23:59:59Z"))).toBe(1);
    expect(sprintNumberAt(CONFIG, new Date("2026-01-19T00:00:00Z"))).toBe(2);
    expect(sprintNumberAt(CONFIG, new Date("2026-03-02T12:00:00Z"))).toBe(5);
  });

  it("clamps dates before the start to sprint 1", () => {
    expect(sprintNumberAt(CONFIG, new Date("2025-12-01T00:00:00Z"))).toBe(1);
  });

  it("returns null for an unusable cadence", () => {
    expect(sprintNumberAt({ ...CONFIG, startDate: "nope" }, new Date())).toBe(
      null,
    );
    expect(sprintNumberAt({ ...CONFIG, weeks: 0 }, new Date())).toBe(null);
  });
});

describe("sprintRange", () => {
  it("is inclusive of its last day and abuts the next sprint", () => {
    expect(sprintRange(CONFIG, 1)).toEqual({
      start: "2026-01-05",
      end: "2026-01-18",
    });
    expect(sprintRange(CONFIG, 2)).toEqual({
      start: "2026-01-19",
      end: "2026-02-01",
    });
  });

  it("rejects sprint numbers below 1", () => {
    expect(sprintRange(CONFIG, 0)).toBe(null);
  });
});

describe("sprintOptions", () => {
  const now = new Date("2026-03-02T12:00:00Z"); // sprint 5

  it("reaches ~20 weeks ahead, so a shorter cadence offers more sprints", () => {
    // 2-week sprints: 10 ahead of the current one (5), plus 2 behind.
    expect(sprintOptions(CONFIG, now)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    // 4-week sprints cover the same calendar in 5 windows.
    const monthly = { ...CONFIG, weeks: 4 };
    const current = sprintNumberAt(monthly, now)!;
    const options = sprintOptions(monthly, now);
    expect(options.at(-1)! - current).toBe(5);
  });

  it("never offers a sprint below 1", () => {
    expect(
      sprintOptions(CONFIG, new Date("2026-01-06T00:00:00Z"), [], {
        future: 3,
      }),
    ).toEqual([1, 2, 3, 4]);
  });

  it("keeps sprints already in use on the board selectable", () => {
    expect(
      sprintOptions(CONFIG, now, [1, 5, null, undefined, 0], { future: 3 }),
    ).toEqual([1, 3, 4, 5, 6, 7, 8]);
  });
});

describe("mondayOfWeek", () => {
  it("walks back to Monday, and Sunday belongs to the week before", () => {
    expect(mondayOfWeek(new Date("2026-01-07T15:00:00Z"))).toBe("2026-01-05");
    expect(mondayOfWeek(new Date("2026-01-05T00:00:00Z"))).toBe("2026-01-05");
    expect(mondayOfWeek(new Date("2026-01-11T23:00:00Z"))).toBe("2026-01-05");
  });
});
