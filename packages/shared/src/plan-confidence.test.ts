import { describe, expect, it } from "bun:test";
import { byConfidenceThenValue, confidenceLevel } from "./plan-confidence";

const loss = (confidence: number, monthly: number | null) => ({
  confidence,
  money: monthly === null ? null : { monthly_value: monthly },
});

describe("confidenceLevel", () => {
  it("reads the engine's confidence in three levels", () => {
    expect(confidenceLevel(0.9)).toBe("high");
    expect(confidenceLevel(0.7)).toBe("high");
    expect(confidenceLevel(0.69)).toBe("medium");
    expect(confidenceLevel(0.4)).toBe("medium");
    expect(confidenceLevel(0.39)).toBe("low");
    expect(confidenceLevel(Number.NaN)).toBeNull();
  });
});

describe("byConfidenceThenValue", () => {
  it("puts more money first within the same level", () => {
    const sorted = [loss(0.92, 100_000), loss(0.88, 1_000_000)].sort(
      byConfidenceThenValue,
    );
    expect(sorted.map((l) => l.money?.monthly_value)).toEqual([
      1_000_000, 100_000,
    ]);
  });

  it("puts a higher level ahead of more money", () => {
    const sorted = [loss(0.6, 1_000_000), loss(0.75, 10_000)].sort(
      byConfidenceThenValue,
    );
    expect(sorted.map((l) => l.confidence)).toEqual([0.75, 0.6]);
  });

  it("puts a loss without money after those with money in its level", () => {
    const sorted = [loss(0.95, null), loss(0.8, 5_000), loss(0.5, 9_000)].sort(
      byConfidenceThenValue,
    );
    expect(sorted.map((l) => l.confidence)).toEqual([0.8, 0.95, 0.5]);
  });

  it("breaks an exact tie on money by raw confidence", () => {
    const sorted = [loss(0.71, 5_000), loss(0.9, 5_000)].sort(
      byConfidenceThenValue,
    );
    expect(sorted.map((l) => l.confidence)).toEqual([0.9, 0.71]);
  });

  it("puts an unreadable confidence last", () => {
    const sorted = [loss(Number.NaN, 9_000_000), loss(0.1, 1)].sort(
      byConfidenceThenValue,
    );
    expect(sorted.map((l) => l.confidence)).toEqual([0.1, Number.NaN]);
  });
});
