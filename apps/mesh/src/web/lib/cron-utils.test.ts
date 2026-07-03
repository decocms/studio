import { describe, expect, test } from "bun:test";
import {
  buildCronFromInterval,
  humanReadableCron,
  isValidCron,
  parseCronToInterval,
} from "./cron-utils.ts";

describe("parseCronToInterval", () => {
  test("round-trips an every-7-days cron as days, not weeks", () => {
    const cron = buildCronFromInterval(7, "days");
    expect(cron).toBe("0 0 */7 * *");
    expect(parseCronToInterval(cron)).toEqual({ count: 7, unit: "days" });
  });

  test("round-trips other day-multiples of 7 as days", () => {
    expect(parseCronToInterval("0 0 */14 * *")).toEqual({
      count: 14,
      unit: "days",
    });
  });

  test("still parses the literal weekly cron as weeks", () => {
    expect(parseCronToInterval("0 0 * * 1")).toEqual({
      count: 1,
      unit: "weeks",
    });
  });
});

describe("humanReadableCron", () => {
  test("formats exact-match schedules", () => {
    expect(humanReadableCron("* * * * *")).toBe("Every minute");
    expect(humanReadableCron("0 * * * *")).toBe("Every hour");
    expect(humanReadableCron("0 0 * * *")).toBe("Every day");
    expect(humanReadableCron("0 0 * * 1")).toBe("Every week");
  });

  test("formats every-N interval schedules", () => {
    expect(humanReadableCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(humanReadableCron("0 */3 * * *")).toBe("Every 3 hours");
    expect(humanReadableCron("0 0 */3 * *")).toBe("Every 3 days");
  });

  test("collapses every-N-days into weeks when N is a multiple of 7", () => {
    expect(humanReadableCron("0 0 */14 * *")).toBe("Every 2 weeks");
  });

  test("formats a specific daily time with zero-padding", () => {
    expect(humanReadableCron("5 9 * * *")).toBe("Every day at 09:05 UTC");
  });

  test("formats a specific weekly time with day name", () => {
    expect(humanReadableCron("30 14 * * 3")).toBe(
      "Every Wednesday at 14:30 UTC",
    );
  });

  test("falls back to the raw expression for unrecognized patterns", () => {
    expect(humanReadableCron("*/5 */2 * * *")).toBe("*/5 */2 * * *");
  });

  test("falls back to a placeholder for empty input", () => {
    expect(humanReadableCron("")).toBe("Unknown schedule");
  });
});

describe("isValidCron", () => {
  test("accepts well-formed 5-field expressions", () => {
    expect(isValidCron("* * * * *")).toBe(true);
    expect(isValidCron("*/5 0 1,15 * 1-5")).toBe(true);
  });

  test("rejects expressions without exactly 5 fields", () => {
    expect(isValidCron("* * * *")).toBe(false);
    expect(isValidCron("* * * * * *")).toBe(false);
  });

  test("rejects fields with invalid characters", () => {
    expect(isValidCron("a * * * *")).toBe(false);
    expect(isValidCron("* * * * MON")).toBe(false);
  });
});
