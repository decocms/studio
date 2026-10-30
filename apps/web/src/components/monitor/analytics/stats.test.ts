import { describe, expect, test } from "bun:test";
import { abTest, controlIndex, erf, phi } from "./stats";

describe("phi", () => {
  test("matches the standard normal CDF", () => {
    expect(phi(0)).toBeCloseTo(0.5, 6);
    expect(phi(1.96)).toBeCloseTo(0.975, 3);
    expect(phi(-1.96)).toBeCloseTo(0.025, 3);
    expect(erf(-1)).toBeCloseTo(-erf(1), 9);
  });
});

describe("abTest", () => {
  test("no exposure in an arm is not a result", () => {
    expect(
      abTest({ visitors: 0, converters: 0 }, { visitors: 10, converters: 1 })
        .state,
    ).toBe("none");
    expect(
      abTest({ visitors: 10, converters: 1 }, { visitors: 0, converters: 0 })
        .state,
    ).toBe("none");
  });

  test("a clear, well-sampled lift wins", () => {
    const r = abTest(
      { visitors: 7777, converters: 140 },
      { visitors: 7777, converters: 202 },
    );
    expect(r.state).toBe("win");
    expect(r.thin).toBe(false);
    expect(r.p).toBeLessThan(0.05);
    expect(r.lift).toBeCloseTo(62 / 140, 6);
    expect(r.ciLo).toBeGreaterThan(0);
    expect(r.ciHi).toBeGreaterThan(r.ciLo ?? 0);
  });

  test("a clear, well-sampled drop loses", () => {
    const r = abTest(
      { visitors: 7777, converters: 202 },
      { visitors: 7777, converters: 140 },
    );
    expect(r.state).toBe("loss");
    expect(r.ciHi).toBeLessThan(0);
  });

  test("fewer than 30 conversions in an arm is never significant", () => {
    const r = abTest(
      { visitors: 400, converters: 5 },
      { visitors: 400, converters: 29 },
    );
    expect(r.thin).toBe(true);
    expect(r.state).toBe("inconclusive");
  });

  test("a small difference on big arms is not yet significant", () => {
    const r = abTest(
      { visitors: 5000, converters: 100 },
      { visitors: 5000, converters: 105 },
    );
    expect(r.state).toBe("inconclusive");
    expect(r.ciLo).toBeLessThan(0);
    expect(r.ciHi).toBeGreaterThan(0);
  });

  test("a control that never converts has no lift", () => {
    const r = abTest(
      { visitors: 100, converters: 0 },
      { visitors: 100, converters: 3 },
    );
    expect(r.lift).toBeNull();
  });

  test("identical arms are not a result", () => {
    const r = abTest(
      { visitors: 1000, converters: 0 },
      { visitors: 1000, converters: 0 },
    );
    expect(r.p).toBe(1);
    expect(r.state).toBe("inconclusive");
  });
});

describe("controlIndex", () => {
  test("prefers a conventional control name", () => {
    expect(controlIndex(["video", "Control"])).toBe(1);
    expect(controlIndex(["b", "a"])).toBe(1);
  });
  test("falls back to the first arm", () => {
    expect(controlIndex(["video", "image"])).toBe(0);
    expect(controlIndex([])).toBe(0);
  });
});
