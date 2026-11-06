import { describe, expect, it } from "bun:test";
import {
  compareArms,
  confidenceAbove,
  cumulativeLift,
  daysRunning,
  daysToMargin,
  liftAxis,
  liftNeededToClaim,
  liftSe,
  logInterval,
  logRatioSe,
  nonInferiorityBar,
  splitCost,
  Z_95,
  Z_95_ONE_SIDED,
} from "./experiment-results-model";

/**
 * Reference values come from running the rollout plan's own script
 * (`ab-rollout-stats.ts`, decocms/reports#439) on the same inputs: its
 * published tables for the plan's baseline (537,215 sessions a day at 3.41%,
 * deff 1.3), and its formulas on the live test's counts.
 */
const S = 537_215;
const P = 0.0341;

describe("the rollout plan's published numbers", () => {
  it("margin of the measured lift by traffic share and days (§3)", () => {
    const hw = (t: number, d: number) =>
      Z_95 * liftSe(P, S * d * (1 - t), S * d * t);
    expect(hw(0.5, 7)).toBeCloseTo(0.012266, 5); // ±1.2%
    expect(hw(0.1, 1)).toBeCloseTo(0.05409, 5); // ±5.4%
    expect(hw(0.05, 14)).toBeCloseTo(0.019899, 5); // ±2.0%
    expect(hw(0.25, 3)).toBeCloseTo(0.021636, 5); // ±2.2%
  });

  it("lift to measure before claiming more than 10% (§5)", () => {
    const se = (t: number, d: number) =>
      logRatioSe(P, S * (1 - t) * d, P * 1.1, S * t * d);
    expect(liftNeededToClaim(0.1, se(0.1, 1))).toBeCloseTo(0.148824, 5);
    expect(liftNeededToClaim(0.1, se(0.01, 1))).toBeCloseTo(0.25313, 5);
    expect(liftNeededToClaim(0.1, se(0.5, 7))).toBeCloseTo(0.11111, 5);
  });

  it("range and confidence when +15% is measured in one day (§5)", () => {
    const at10 = logRatioSe(P, S * 0.9, P * 1.1, S * 0.1);
    const [lo, hi] = logInterval(0.15, at10, Z_95_ONE_SIDED);
    expect(lo).toBeCloseTo(0.101126, 5);
    expect(hi).toBeCloseTo(0.201043, 5);
    expect(confidenceAbove(0.15, 0.1, at10)).toBeCloseTo(0.95387, 4);

    const at1 = logRatioSe(P, S * 0.99, P * 1.1, S * 0.01);
    const [lo1, hi1] = logInterval(0.15, at1, Z_95_ONE_SIDED);
    expect(lo1).toBeCloseTo(0.009473, 5);
    expect(hi1).toBeCloseTo(0.31009, 5);
    expect(confidenceAbove(0.15, 0.1, at1)).toBeCloseTo(0.7126, 4);
  });

  it("exactly the target measured is a coin flip", () => {
    expect(confidenceAbove(0.1, 0.1, 0.05)).toBeCloseTo(0.5, 6);
  });

  it("rollback on a significant drop and GO by non-inferiority at −2% (§6)", () => {
    // One day at 10%: rollback if conversion falls more than 4.5%.
    expect(Z_95_ONE_SIDED * liftSe(P, S * 0.9, S * 0.1)).toBeCloseTo(
      0.045393,
      5,
    );
    // The whole ramp: GO once the measured lift is at least −0.9%.
    expect(nonInferiorityBar(0.006698782776)).toBeCloseTo(-0.008981, 5);
  });

  it("cost of an uneven split against 50/50 (slide desvio)", () => {
    expect(splitCost(0.5)).toBe(1);
    expect(splitCost(0.25)).toBeCloseTo(1.3333, 4);
    expect(splitCost(0.1)).toBeCloseTo(2.7778, 4);
    expect(splitCost(0.05)).toBeCloseTo(5.2632, 4);
  });
});

describe("compareArms", () => {
  it("reads the live test's lower point estimate as no clear difference", () => {
    // 19.8% of 1,985 exposed against 16.9% of 414.
    const r = compareArms(
      { successes: 393, total: 1985 },
      { successes: 70, total: 414 },
    );
    expect(r.lift).toBeCloseTo(-0.145985, 5);
    expect(r.low).toBeCloseTo(-0.343858, 5);
    expect(r.high).toBeCloseTo(0.111561, 5);
    expect(r.pBetter).toBeCloseTo(0.120303, 4);
    expect(r.pBetterTarget).toBeCloseTo(0.029903, 4);
    expect(r.margin).toBeCloseTo(0.243013, 5);
    // GO needs the measured lift at −2% plus the one-sided margin.
    expect(r.notWorseAt).toBeCloseTo(0.183943, 5);
    expect(r.safety).toBe("open");
    expect(r.significant).toBe(false);
    expect(r.verdict).toBe("unclear");
  });

  it("matches the plan's script on the test's latest counts", () => {
    const r = compareArms(
      { successes: 346, total: 1757 },
      { successes: 58, total: 335 },
    );
    expect(r.lift).toBeCloseTo(-0.120818, 5);
    expect(r.low).toBeCloseTo(-0.340641, 5);
    expect(r.high).toBeCloseTo(0.172293, 5);
    expect(r.pBetter).toBeCloseTo(0.190209, 4);
    expect(r.pBetterTarget).toBeCloseTo(0.063458, 4);
    expect(r.margin).toBeCloseTo(0.269041, 5);
    expect(r.verdict).toBe("unclear");
  });

  it("an interval across zero stays unclear even with the point above it", () => {
    const r = compareArms(
      { successes: 178, total: 812 },
      { successes: 32, total: 140 },
    );
    expect(r.lift).toBeCloseTo(0.042697, 5);
    expect(r.low).toBeCloseTo(-0.284954, 5);
    expect(r.high).toBeCloseTo(0.520485, 5);
    expect(r.pBetter).toBeCloseTo(0.585989, 4);
    expect(r.verdict).toBe("unclear");
  });

  it("counts a lift only when significant, one-sided at 95%", () => {
    const r = compareArms(
      { successes: 200, total: 2000 },
      { successes: 300, total: 2000 },
    );
    expect(r.lift).toBeCloseTo(0.5, 6);
    expect(r.low).toBeCloseTo(0.238742, 5);
    expect(r.high).toBeCloseTo(0.816358, 5);
    expect(r.pBetter).toBeCloseTo(0.999984, 4);
    expect(r.margin).toBeCloseTo(0.212003, 5);
    expect(r.significant).toBe(true);
    expect(r.safety).toBe("notWorse");
    expect(r.verdict).toBe("better");
  });

  it("calls a significant drop worse", () => {
    const r = compareArms(
      { successes: 300, total: 2000 },
      { successes: 200, total: 2000 },
    );
    expect(r.safety).toBe("worse");
    expect(r.verdict).toBe("worse");
    expect(r.significant).toBe(false);
  });

  it("says not worse once the lift clears −2% plus the one-sided margin", () => {
    // 10% on 200,000 exposed per arm, equal rates: se about 0.98%.
    const r = compareArms(
      { successes: 20_000, total: 200_000 },
      { successes: 20_100, total: 200_000 },
    );
    expect(r.lift).toBeCloseTo(0.005, 6);
    expect(r.significant).toBe(false);
    expect(r.safety).toBe("notWorse");
    expect(r.verdict).toBe("notWorse");
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
      expect(r).toMatchObject({
        lift: null,
        low: null,
        high: null,
        margin: null,
        notWorseAt: null,
        pBetter: null,
        safety: null,
        verdict: "few",
      });
    }
  });

  it("has no interval while the test has no conversions", () => {
    const r = compareArms(
      { successes: 50, total: 500 },
      { successes: 0, total: 500 },
    );
    expect(r.lift).toBe(-1);
    expect(r).toMatchObject({ low: null, high: null, pBetter: null });
    expect(r.verdict).toBe("few");
  });

  it("reads equal arms as even odds with a symmetric margin", () => {
    const r = compareArms(
      { successes: 100, total: 1000 },
      { successes: 100, total: 1000 },
    );
    expect(r.lift).toBe(0);
    expect(r.pBetter).toBeCloseTo(0.5, 6);
    expect(r.low).toBeCloseTo(1 / (1 + (r.high ?? 0)) - 1, 10);
    expect(r.verdict).toBe("unclear");
  });

  it("does not divide by zero when every visitor converts", () => {
    const r = compareArms(
      { successes: 200, total: 200 },
      { successes: 200, total: 200 },
    );
    expect(r).toMatchObject({ lift: 0, low: 0, high: 0, margin: 0 });
    expect(r.pBetter).toBe(0.5);
    expect(r.verdict).toBe("notWorse");
  });
});

describe("daysToMargin", () => {
  const control = { successes: 393, total: 1985 };
  const test = { successes: 70, total: 414 };

  it("narrows with the square root of days at the traffic so far", () => {
    // ±24.3% after 2 days: ±10% needs 11.8 days in all.
    expect(daysToMargin(control, test, 2, 0.1)).toEqual({
      days: 10,
      exposed: 11_995,
      evenSplitDays: 6,
    });
    expect(daysToMargin(control, test, 2, 0.05)).toEqual({
      days: 46,
      exposed: 55_177,
      evenSplitDays: 26,
    });
  });

  it("is 0 once the margin is already there", () => {
    expect(
      daysToMargin(
        { successes: 200, total: 2000 },
        { successes: 300, total: 2000 },
        7,
        0.3,
      ),
    ).toEqual({ days: 0, exposed: 0, evenSplitDays: 0 });
  });

  it("is null without days or a base rate", () => {
    expect(daysToMargin(control, test, 0, 0.1)).toBeNull();
    expect(daysToMargin({ successes: 0, total: 50 }, test, 3, 0.1)).toBeNull();
  });
});

describe("cumulativeLift", () => {
  it("adds the days up and narrows the range as they come in", () => {
    const points = cumulativeLift(
      [
        { date: "2026-11-05", counts: { successes: 220, total: 1043 } },
        { date: "2026-11-04", counts: { successes: 59, total: 258 } },
        { date: "2026-11-06", counts: { successes: 67, total: 456 } },
      ],
      [
        { date: "2026-11-04", counts: { successes: 8, total: 43 } },
        { date: "2026-11-05", counts: { successes: 37, total: 199 } },
        { date: "2026-11-06", counts: { successes: 13, total: 93 } },
      ],
    );
    expect(points.map((p) => p.date)).toEqual([
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
    ]);
    const last = points.at(-1);
    const total = compareArms(
      { successes: 346, total: 1757 },
      { successes: 58, total: 335 },
    );
    expect(last?.lift).toBeCloseTo(total.lift ?? 0, 10);
    expect(last?.low).toBeCloseTo(total.low ?? 0, 10);
    const width = (p: (typeof points)[number]) => (p.high ?? 0) - (p.low ?? 0);
    expect(width(points[0]!)).toBeGreaterThan(width(points[2]!));
  });

  it("leaves a day without a base rate empty", () => {
    const points = cumulativeLift(
      [{ date: "2026-11-04", counts: { successes: 0, total: 10 } }],
      [{ date: "2026-11-04", counts: { successes: 1, total: 10 } }],
    );
    expect(points).toEqual([
      { date: "2026-11-04", lift: null, low: null, high: null },
    ]);
  });
});

describe("liftAxis", () => {
  it("spans the range, zero and the −2% line on round steps", () => {
    expect(liftAxis([-0.3439, 0.1116])).toEqual({
      min: -0.4,
      max: 0.2,
      ticks: [-0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2],
    });
    expect(liftAxis([0.2387, 0.8164])).toEqual({
      min: -0.2,
      max: 1,
      ticks: [-0.2, 0, 0.2, 0.4, 0.6, 0.8, 1],
    });
  });

  it("keeps the −2% line in view on a tight range", () => {
    expect(liftAxis([-0.005, 0.004])).toEqual({
      min: -0.03,
      max: 0.01,
      ticks: [-0.03, -0.02, -0.01, 0, 0.01],
    });
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
