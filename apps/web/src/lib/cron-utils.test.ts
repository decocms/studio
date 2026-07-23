import { describe, expect, test } from "bun:test";
import { buildCronFromInterval, parseCronToInterval } from "./cron-utils.ts";

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
