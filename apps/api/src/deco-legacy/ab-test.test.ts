import { describe, expect, test } from "bun:test";
import {
  experimentStats,
  normalCdf,
  pBetter,
  sampleSize,
  type Variant,
} from "./ab-test";

describe("normalCdf", () => {
  test("is 0.5 at the mean", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 5);
  });

  test("matches known z-values", () => {
    // Standard normal: Φ(1.96) ≈ 0.975, Φ(1.645) ≈ 0.95.
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(1.644853)).toBeCloseTo(0.95, 3);
  });

  test("is symmetric: Φ(-x) = 1 - Φ(x)", () => {
    for (const x of [0.3, 1, 2.5]) {
      expect(normalCdf(-x)).toBeCloseTo(1 - normalCdf(x), 6);
    }
  });
});

describe("pBetter", () => {
  test("is ~0.5 when both variants convert identically", () => {
    const p = pBetter(
      { successes: 100, total: 1000 },
      { successes: 100, total: 1000 },
    );
    expect(p).toBeCloseTo(0.5, 2);
  });

  test("exceeds 0.5 when B converts clearly better than A", () => {
    const p = pBetter(
      { successes: 100, total: 1000 },
      { successes: 200, total: 1000 },
    );
    expect(p).toBeGreaterThan(0.9);
  });

  test("is below 0.5 when B converts worse than A", () => {
    const p = pBetter(
      { successes: 200, total: 1000 },
      { successes: 100, total: 1000 },
    );
    expect(p).toBeLessThan(0.1);
  });

  test("returns a finite number (never NaN) on degenerate zero-total input", () => {
    const p = pBetter({ successes: 0, total: 0 }, { successes: 0, total: 0 });
    expect(Number.isFinite(p)).toBe(true);
  });
});

describe("sampleSize", () => {
  test("returns null before the control has enough data", () => {
    expect(
      sampleSize({ successes: 5, total: 100 }, { successes: 6, total: 100 }),
    ).toBeNull();
  });

  test("returns null when the control has zero successes", () => {
    expect(
      sampleSize({ successes: 0, total: 5000 }, { successes: 10, total: 5000 }),
    ).toBeNull();
  });

  test("returns a positive integer once there is a control to size against", () => {
    const n = sampleSize(
      { successes: 100, total: 5000 },
      { successes: 130, total: 5000 },
    );
    expect(n).not.toBeNull();
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });
});

describe("experimentStats", () => {
  test("leaves the probabilities null while an arm has no data", () => {
    const cases: [Variant, Variant][] = [
      [
        { successes: 0, total: 0 },
        { successes: 3, total: 100 },
      ],
      [
        { successes: 3, total: 100 },
        { successes: 0, total: 100 },
      ],
      [
        { successes: 0, total: 100 },
        { successes: 0, total: 100 },
      ],
    ];
    for (const [a, b] of cases) {
      const stats = experimentStats(a, b, a.total + b.total);
      expect(stats.probabilityVariantBest).toBeNull();
      expect(stats.probabilityDefaultBest).toBeNull();
    }
  });

  test("keeps the numbers once both arms converted", () => {
    const a = { successes: 20, total: 1000 };
    const b = { successes: 30, total: 1000 };
    const p = pBetter(a, b);
    expect(experimentStats(a, b, 2000)).toEqual({
      totalParticipants: 2000,
      sampleSize: sampleSize(a, b) ?? 1000,
      probabilityVariantBest: p,
      probabilityDefaultBest: 1 - p,
    });
  });
});
