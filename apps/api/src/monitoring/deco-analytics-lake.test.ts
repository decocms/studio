import { describe, expect, it } from "bun:test";
import { lakeWindow, previousCoverage } from "./deco-analytics-lake";

const NOW = Date.parse("2026-11-04T18:42:00Z");

describe("lakeWindow", () => {
  it("ends with the current hour and has an equal window before it", () => {
    expect(lakeWindow("24h", NOW)).toEqual({
      from: "2026-11-03 19:00:00",
      prevFrom: "2026-11-02 19:00:00",
      hours: 24,
    });
  });
  it("reads the current hour for sub-hour ranges", () => {
    expect(lakeWindow("5m", NOW)?.from).toBe("2026-11-04 18:00:00");
  });
  it("rejects a range the read surface doesn't have", () => {
    expect(lakeWindow("90d", NOW)).toBeNull();
  });
});

describe("previousCoverage", () => {
  const win = { from: "2026-11-03 19:00:00", prevFrom: "2026-11-02 19:00:00" };
  it("is whole when data starts before the previous window", () => {
    expect(previousCoverage("2026-10-01 00:00:00", win)).toBe(1);
  });
  it("is the share the data covers", () => {
    expect(previousCoverage("2026-11-03 07:00:00", win)).toBe(0.5);
  });
  it("is zero with no rows or rows only in the current window", () => {
    expect(previousCoverage(null, win)).toBe(0);
    expect(previousCoverage("2026-11-04 01:00:00", win)).toBe(0);
  });
});

it("ignores inherited property names as ranges", () => {
  expect(lakeWindow("constructor", NOW)).toBeNull();
  expect(lakeWindow("toString", NOW)).toBeNull();
});
