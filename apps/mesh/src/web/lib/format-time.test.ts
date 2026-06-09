import { describe, expect, test } from "bun:test";
import { subSeconds } from "date-fns";
import {
  computeElapsedMs,
  formatDuration,
  formatTimeAgo,
  toEpochMs,
} from "./format-time";

describe("formatTimeAgo", () => {
  test("returns <1m for dates less than 60 seconds ago", () => {
    const now = new Date();
    expect(formatTimeAgo(subSeconds(now, 0))).toBe("<1m");
    expect(formatTimeAgo(subSeconds(now, 30))).toBe("<1m");
    expect(formatTimeAgo(subSeconds(now, 59))).toBe("<1m");
  });

  test("returns Xm ago for minutes", () => {
    const now = new Date();
    expect(formatTimeAgo(subSeconds(now, 60))).toBe("1m ago");
    expect(formatTimeAgo(subSeconds(now, 90))).toBe("1m ago");
    expect(formatTimeAgo(subSeconds(now, 120))).toBe("2m ago");
    expect(formatTimeAgo(subSeconds(now, 3540))).toBe("59m ago");
  });

  test("returns Xh ago for hours", () => {
    const now = new Date();
    expect(formatTimeAgo(subSeconds(now, 3600))).toBe("1h ago");
    expect(formatTimeAgo(subSeconds(now, 7200))).toBe("2h ago");
    expect(formatTimeAgo(subSeconds(now, 86399))).toBe("23h ago");
  });

  test("returns Xd ago for days", () => {
    const now = new Date();
    expect(formatTimeAgo(subSeconds(now, 86400))).toBe("1d ago");
    expect(formatTimeAgo(subSeconds(now, 172800))).toBe("2d ago");
    expect(formatTimeAgo(subSeconds(now, 604799))).toBe("6d ago");
  });

  test("returns Xw ago for weeks", () => {
    const now = new Date();
    expect(formatTimeAgo(subSeconds(now, 604800))).toBe("1w ago");
    expect(formatTimeAgo(subSeconds(now, 2591999))).toBe("4w ago");
  });

  test("returns Xmo ago for months", () => {
    const now = new Date();
    expect(formatTimeAgo(subSeconds(now, 2592000))).toBe("1mo ago");
    expect(formatTimeAgo(subSeconds(now, 31535999))).toBe("12mo ago");
  });

  test("returns Xy ago for years", () => {
    const now = new Date();
    expect(formatTimeAgo(subSeconds(now, 31536000))).toBe("1y ago");
    expect(formatTimeAgo(subSeconds(now, 63072000))).toBe("2y ago");
  });
});

describe("formatDuration", () => {
  test("formats seconds under 60", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(1.23)).toBe("1.2s");
    expect(formatDuration(59.9)).toBe("59.9s");
  });

  test("formats minutes and seconds at 60+", () => {
    expect(formatDuration(60)).toBe("1m 0.0s");
    expect(formatDuration(61.5)).toBe("1m 1.5s");
    expect(formatDuration(125.7)).toBe("2m 5.7s");
    expect(formatDuration(3661)).toBe("61m 1.0s");
  });

  test("does not produce 60.0s at minute boundaries", () => {
    expect(formatDuration(119.95)).toBe("2m 0.0s");
    expect(formatDuration(179.96)).toBe("3m 0.0s");
  });
});

describe("toEpochMs", () => {
  test("returns null for undefined", () => {
    expect(toEpochMs(undefined)).toBeNull();
  });

  test("returns null for null", () => {
    expect(toEpochMs(null)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(toEpochMs("")).toBeNull();
  });

  test("returns epoch ms for an ISO date string", () => {
    expect(toEpochMs("2024-01-01T00:00:00.000Z")).toBe(Date.UTC(2024, 0, 1));
  });

  test("returns getTime() for a Date instance", () => {
    const d = new Date("2024-06-01T12:34:56.000Z");
    expect(toEpochMs(d)).toBe(d.getTime());
  });

  test("returns null for an unparseable string", () => {
    expect(toEpochMs("not-a-date")).toBeNull();
  });

  test("returns null for an Invalid Date instance", () => {
    expect(toEpochMs(new Date("invalid"))).toBeNull();
  });
});

describe("computeElapsedMs", () => {
  test("returns positive elapsed when now is after start", () => {
    expect(computeElapsedMs(1_000, 3_500)).toBe(2_500);
  });

  test("returns 0 when now equals start", () => {
    expect(computeElapsedMs(1_000, 1_000)).toBe(0);
  });

  test("clamps to 0 when start is ahead of now (server clock skew)", () => {
    // serverStartedAt > Date.now() — e.g. server clock 30s ahead of client.
    // Without the clamp, the live timer would render "-30.0s".
    expect(computeElapsedMs(30_000, 0)).toBe(0);
  });

  test("clamps to 0 for small sub-second skew", () => {
    expect(computeElapsedMs(1_500, 1_200)).toBe(0);
  });
});
