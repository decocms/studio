import { describe, expect, test } from "bun:test";
import {
  changeTone,
  formatMs,
  formatRate,
  formatShare,
  monitorKind,
  relativeChange,
  releaseBucket,
  shortRelease,
  sinceLabel,
} from "./monitor-v8";

describe("monitorKind", () => {
  test("a v8 site opens the telemetry Monitor, a v7 one keeps the CDN Monitor", () => {
    expect(monitorKind("v8")).toBe("v8");
    expect(monitorKind("v7")).toBe("v7");
  });

  test("a site last found v8 whose main can't be read stays on the v8 Monitor", () => {
    expect(monitorKind("error")).toBe("v8");
  });

  test("shows neither while main's schema is being read", () => {
    expect(monitorKind("loading")).toBe("loading");
  });
});

describe("deltas", () => {
  test("relative change, unknown without a previous value", () => {
    expect(relativeChange(120, 100)).toBeCloseTo(0.2, 9);
    expect(relativeChange(80, 100)).toBeCloseTo(-0.2, 9);
    expect(relativeChange(5, 0)).toBeNull();
    expect(relativeChange(null, 100)).toBeNull();
    expect(relativeChange(100, null)).toBeNull();
  });

  test("tone follows which direction is better for the tile", () => {
    expect(changeTone(0.2, "down")).toBe("bad"); // slower / more errors
    expect(changeTone(-0.2, "down")).toBe("good");
    expect(changeTone(0.2, "up")).toBe("good"); // more cache hits
    expect(changeTone(0.2, "none")).toBe("neutral"); // traffic
    expect(changeTone(0.005, "down")).toBe("neutral");
    expect(changeTone(null, "up")).toBe("neutral");
  });
});

describe("formatting", () => {
  test("durations", () => {
    expect(formatMs(null)).toBe("—");
    expect(formatMs(84)).toBe("84 ms");
    expect(formatMs(1250)).toBe("1.3 s");
    expect(formatMs(12_400)).toBe("12 s");
  });

  test("shares", () => {
    expect(formatShare(null)).toBe("—");
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(0.0004)).toBe("<0.1%");
    expect(formatShare(0.004)).toBe("0.4%");
    expect(formatShare(0.71)).toBe("71%");
  });

  test("rates switch to per minute under one a second", () => {
    expect(formatRate(13.4)).toEqual({ value: "13", unit: "s" });
    expect(formatRate(0.5)).toEqual({ value: "30", unit: "min" });
    expect(formatRate(0.002)).toEqual({ value: "0.1", unit: "min" });
    expect(formatRate(0)).toEqual({ value: "0", unit: "min" });
  });

  test("release ids and ages", () => {
    expect(shortRelease("4b59af4701ea5fd0")).toBe("4b59af4");
    const now = Date.parse("2026-10-19T12:00:00Z");
    expect(sinceLabel(now - 20_000, now)).toEqual({ count: 0, unit: "now" });
    expect(sinceLabel(now - 5 * 60_000, now)).toEqual({
      count: 5,
      unit: "min",
    });
    expect(sinceLabel(now - 3 * 3_600_000, now)).toEqual({
      count: 3,
      unit: "h",
    });
    expect(sinceLabel(now - 50 * 3_600_000, now)).toEqual({
      count: 2,
      unit: "d",
    });
  });
});

describe("releaseBucket", () => {
  const window = {
    startMs: Date.parse("2026-10-19T11:00:00Z"),
    endMs: Date.parse("2026-10-19T12:00:00Z"),
    stepS: 60,
  };

  test("puts a release on the bucket it first showed up in", () => {
    expect(releaseBucket(Date.parse("2026-10-19T11:30:42Z"), window)).toBe(
      Date.parse("2026-10-19T11:30:00Z"),
    );
    expect(releaseBucket(window.startMs, window)).toBe(window.startMs);
  });

  test("drops a release outside the window", () => {
    expect(releaseBucket(window.startMs - 1, window)).toBeNull();
    expect(releaseBucket(window.endMs, window)).toBeNull();
  });
});
