import { describe, expect, it } from "bun:test";
import {
  expressionToDate,
  findQuickRange,
  formatForDateTimeInput,
  getExpressionLabel,
  getTimeRangeDisplayText,
  isTimeExpression,
  isValidExpression,
  parseExpression,
} from "./time-expressions";

describe("parseExpression", () => {
  it("parses bare 'now'", () => {
    expect(parseExpression("now")).toEqual({
      isNow: true,
      offset: 0,
      unit: null,
    });
  });

  it("parses an offset expression", () => {
    expect(parseExpression("now-5m")).toEqual({
      isNow: true,
      offset: 5,
      unit: "m",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseExpression("  now-3h  ")).toEqual({
      isNow: true,
      offset: 3,
      unit: "h",
    });
  });

  it("returns null for a dangling offset with no digits/unit", () => {
    expect(parseExpression("now-")).toBeNull();
  });

  it("returns null for an unrecognized unit", () => {
    expect(parseExpression("now-5x")).toBeNull();
  });

  it("returns null for a plain non-expression string", () => {
    expect(parseExpression("2024-01-01")).toBeNull();
  });
});

describe("expressionToDate", () => {
  it("resolves an ISO date string directly", () => {
    const result = expressionToDate("2024-01-15");
    expect(result.valid).toBe(true);
    expect(result.date?.getTime()).toBe(new Date("2024-01-15").getTime());
  });

  it("resolves 'now' to the current time", () => {
    const before = Date.now();
    const result = expressionToDate("now");
    const after = Date.now();
    expect(result.valid).toBe(true);
    expect(result.date!.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.date!.getTime()).toBeLessThanOrEqual(after);
  });

  it("resolves a zero offset to the current time regardless of unit", () => {
    const before = Date.now();
    const result = expressionToDate("now-0m");
    const after = Date.now();
    expect(result.valid).toBe(true);
    expect(result.date!.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.date!.getTime()).toBeLessThanOrEqual(after);
  });

  it("subtracts minutes/hours/days/weeks/months for their respective units", () => {
    const now = Date.now();
    const oneMinute = 60 * 1000;
    const tolerance = 5000;

    const minutes = expressionToDate("now-5m").date!.getTime();
    expect(now - minutes).toBeGreaterThanOrEqual(5 * oneMinute - tolerance);
    expect(now - minutes).toBeLessThanOrEqual(5 * oneMinute + tolerance);

    const hours = expressionToDate("now-2h").date!.getTime();
    expect(now - hours).toBeGreaterThanOrEqual(2 * 60 * oneMinute - tolerance);
    expect(now - hours).toBeLessThanOrEqual(2 * 60 * oneMinute + tolerance);

    const days = expressionToDate("now-1d").date!.getTime();
    expect(now - days).toBeGreaterThanOrEqual(24 * 60 * oneMinute - tolerance);
    expect(now - days).toBeLessThanOrEqual(24 * 60 * oneMinute + tolerance);

    const weeks = expressionToDate("now-1w").date!.getTime();
    const days1 = expressionToDate("now-7d").date!.getTime();
    expect(Math.abs(weeks - days1)).toBeLessThanOrEqual(tolerance);

    const months = expressionToDate("now-1M").date!.getTime();
    expect(now - months).toBeGreaterThan(20 * 24 * 60 * oneMinute);
  });

  it("is invalid for garbage input", () => {
    const result = expressionToDate("not a real expression");
    expect(result.valid).toBe(false);
    expect(result.date).toBeNull();
    expect(result.error).toBeTruthy();
  });
});

describe("isTimeExpression", () => {
  it("is true for 'now' style expressions", () => {
    expect(isTimeExpression("now")).toBe(true);
    expect(isTimeExpression("now-30d")).toBe(true);
  });

  it("is false for absolute date strings, even valid ones", () => {
    expect(isTimeExpression("2024-01-15")).toBe(false);
  });

  it("is false for garbage input", () => {
    expect(isTimeExpression("whenever")).toBe(false);
  });
});

describe("isValidExpression", () => {
  it("accepts 'now' expressions and ISO dates", () => {
    expect(isValidExpression("now-1h")).toBe(true);
    expect(isValidExpression("2024-01-15")).toBe(true);
  });

  it("rejects garbage input", () => {
    expect(isValidExpression("whenever")).toBe(false);
  });
});

describe("getExpressionLabel", () => {
  it("labels 'now' as 'Now'", () => {
    expect(getExpressionLabel("now")).toBe("Now");
  });

  it("singularizes a 1-unit offset", () => {
    expect(getExpressionLabel("now-1h")).toBe("1 hour ago");
  });

  it("pluralizes a multi-unit offset", () => {
    expect(getExpressionLabel("now-2h")).toBe("2 hours ago");
    expect(getExpressionLabel("now-30d")).toBe("30 days ago");
  });

  it("falls back to the raw string for unparseable input", () => {
    expect(getExpressionLabel("whenever")).toBe("whenever");
  });
});

describe("findQuickRange", () => {
  it("finds a known preset by value", () => {
    expect(findQuickRange("1h")).toEqual({
      label: "Last 1 hour",
      from: "now-1h",
      to: "now",
      value: "1h",
    });
  });

  it("returns undefined for an unknown value", () => {
    expect(findQuickRange("999y")).toBeUndefined();
  });
});

describe("getTimeRangeDisplayText", () => {
  it("uses the quick-range label when from/to match a preset", () => {
    expect(getTimeRangeDisplayText("now-1h", "now")).toBe("Last 1 hour");
  });

  it("falls back to formatted labels for a non-preset range", () => {
    expect(getTimeRangeDisplayText("now-3d", "now-1d")).toBe(
      "3 days ago to 1 day ago",
    );
  });
});

describe("formatForDateTimeInput", () => {
  it("formats a date as YYYY-MM-DDTHH:MM in local time", () => {
    const date = new Date(2024, 0, 5, 9, 7);
    expect(formatForDateTimeInput(date)).toBe("2024-01-05T09:07");
  });

  it("zero-pads single-digit month/day/hour/minute", () => {
    const date = new Date(2024, 8, 1, 0, 5);
    expect(formatForDateTimeInput(date)).toBe("2024-09-01T00:05");
  });
});
