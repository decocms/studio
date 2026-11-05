import { describe, expect, it } from "bun:test";
import { compareArms, daysLeft, daysRunning } from "./experiment-results-model";

describe("compareArms", () => {
  it("calls a tie when the interval crosses zero", () => {
    const r = compareArms(
      { successes: 178, total: 812 },
      { successes: 32, total: 140 },
    );
    expect(r.verdict).toBe("tie");
    expect(r.lift).toBeCloseTo(0.0428, 3);
    expect(r.low).toBeCloseTo(-0.3, 2);
    expect(r.high).toBeCloseTo(0.386, 2);
    expect(r.p).toBeGreaterThan(0.05);
  });

  it("names a clear winner and a clear loser", () => {
    const ahead = compareArms(
      { successes: 200, total: 2000 },
      { successes: 300, total: 2000 },
    );
    expect(ahead.verdict).toBe("ahead");
    expect(ahead.lift).toBeCloseTo(0.5, 5);
    expect(ahead.low).toBeGreaterThan(0);
    expect(ahead.p).toBeLessThan(0.001);

    const behind = compareArms(
      { successes: 300, total: 2000 },
      { successes: 200, total: 2000 },
    );
    expect(behind.verdict).toBe("behind");
    expect(behind.high).toBeLessThan(0);
  });

  it("asks for more data below 100 per arm or 10 conversions", () => {
    expect(
      compareArms({ successes: 30, total: 99 }, { successes: 60, total: 99 })
        .verdict,
    ).toBe("few");
    expect(
      compareArms({ successes: 9, total: 5000 }, { successes: 90, total: 5000 })
        .verdict,
    ).toBe("few");
  });

  it("has no lift without control conversions or traffic", () => {
    for (const [c, t] of [
      [
        { successes: 0, total: 500 },
        { successes: 20, total: 500 },
      ],
      [
        { successes: 0, total: 0 },
        { successes: 0, total: 0 },
      ],
    ] as const) {
      const r = compareArms(c, t);
      expect(r).toMatchObject({ lift: null, low: null, p: null });
      expect(r.verdict).toBe("few");
    }
  });

  it("reads equal arms as an even tie", () => {
    const r = compareArms(
      { successes: 100, total: 1000 },
      { successes: 100, total: 1000 },
    );
    expect(r.verdict).toBe("tie");
    expect(r.lift).toBe(0);
    expect(r.p).toBeCloseTo(1, 5);
    expect(r.low).toBeCloseTo(-(r.high ?? 0), 10);
  });

  it("does not divide by zero when every visitor converts", () => {
    const r = compareArms(
      { successes: 200, total: 200 },
      { successes: 200, total: 200 },
    );
    expect(r).toMatchObject({ lift: 0, low: 0, high: 0, p: 1, verdict: "tie" });
  });
});

describe("daysLeft", () => {
  it("estimates from each arm's own daily traffic", () => {
    // 406 and 70 exposed a day at 21.9%: about 50 days in all.
    expect(
      daysLeft(
        { successes: 178, total: 812 },
        { successes: 32, total: 140 },
        2,
      ),
    ).toBe(48);
  });

  it("is 0 once there is enough, null without enough to estimate", () => {
    expect(
      daysLeft(
        { successes: 5000, total: 50000 },
        { successes: 5000, total: 50000 },
        30,
      ),
    ).toBe(0);
    expect(
      daysLeft({ successes: 5, total: 50 }, { successes: 5, total: 50 }, 3),
    ).toBeNull();
    expect(
      daysLeft({ successes: 50, total: 500 }, { successes: 50, total: 500 }, 0),
    ).toBeNull();
  });
});

describe("daysRunning", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  it("counts started days, at least one", () => {
    expect(daysRunning("2026-11-04T09:00:00Z", now)).toBe(2);
    expect(daysRunning("2026-11-05T11:00:00Z", now)).toBe(1);
    expect(daysRunning(null, now)).toBe(0);
    expect(daysRunning("2026-11-06T00:00:00Z", now)).toBe(0);
  });
});
