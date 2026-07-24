import { describe, expect, it } from "bun:test";
import {
  parseGroupedArrays,
  mergeHistogramBuckets,
  computePercentileFromHistogramBuckets,
} from "./monitoring-sql";

describe("parseGroupedArrays", () => {
  it("returns empty array for falsy input", () => {
    expect(parseGroupedArrays(null)).toEqual([]);
    expect(parseGroupedArrays(undefined)).toEqual([]);
    expect(parseGroupedArrays("")).toEqual([]);
  });

  it("parses array of JSON strings", () => {
    const input = ["[1,2,3]", "[4,5,6]"];
    expect(parseGroupedArrays(input)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it("handles array of arrays (already parsed)", () => {
    const input = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    expect(parseGroupedArrays(input)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it("handles JSON string wrapping an array of strings", () => {
    const input = JSON.stringify(["[1,2]", "[3,4]"]);
    expect(parseGroupedArrays(input)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("returns empty arrays for invalid JSON items", () => {
    const input = ["not-json", "[1,2]"];
    expect(parseGroupedArrays(input)).toEqual([[], [1, 2]]);
  });
});

describe("mergeHistogramBuckets", () => {
  it("returns empty for empty input", () => {
    expect(mergeHistogramBuckets([], [])).toEqual({
      boundaries: [],
      counts: [],
    });
  });

  it("returns empty when all boundaries are empty", () => {
    expect(mergeHistogramBuckets([[], []], [[], []])).toEqual({
      boundaries: [],
      counts: [],
    });
  });

  it("merges single histogram (passthrough)", () => {
    const result = mergeHistogramBuckets([[10, 50, 100]], [[2, 3, 1, 0]]);
    expect(result).toEqual({
      boundaries: [10, 50, 100],
      counts: [2, 3, 1, 0],
    });
  });

  it("sums counts from multiple histograms with same boundaries", () => {
    const result = mergeHistogramBuckets(
      [
        [10, 50, 100],
        [10, 50, 100],
      ],
      [
        [1, 2, 3, 4],
        [5, 6, 7, 8],
      ],
    );
    expect(result).toEqual({
      boundaries: [10, 50, 100],
      counts: [6, 8, 10, 12],
    });
  });

  it("handles shorter count arrays gracefully", () => {
    const result = mergeHistogramBuckets(
      [[10, 50, 100]],
      [[1, 2]], // only 2 counts instead of 4
    );
    expect(result).toEqual({
      boundaries: [10, 50, 100],
      counts: [1, 2, 0, 0],
    });
  });

  it("skips empty count arrays", () => {
    const result = mergeHistogramBuckets(
      [
        [10, 50],
        [10, 50],
      ],
      [[], [3, 5, 7]],
    );
    expect(result).toEqual({
      boundaries: [10, 50],
      counts: [3, 5, 7],
    });
  });
});

describe("computePercentileFromHistogramBuckets", () => {
  it("returns 0 for empty input", () => {
    expect(computePercentileFromHistogramBuckets([], [], 0.5)).toBe(0);
  });

  it("returns 0 when all counts are 0", () => {
    expect(
      computePercentileFromHistogramBuckets([10, 50, 100], [0, 0, 0, 0], 0.5),
    ).toBe(0);
  });

  it("computes p50 for a simple distribution", () => {
    // Boundaries: [100], Counts: [3, 2] (3 in [0,100], 2 in [100,200])
    // Total: 5, p50 target: 2.5
    // Falls in first bucket [0,100]: fraction = 2.5/3 = 0.833...
    // Result: 0 + 0.833 * 100 = 83.33
    const result = computePercentileFromHistogramBuckets([100], [3, 2], 0.5);
    expect(result).toBeCloseTo(83.33, 1);
  });

  it("computes p95 falling in later bucket", () => {
    // Boundaries: [10, 50, 100], Counts: [5, 10, 3, 2] (total: 20)
    // p95 target: 19
    // Cumulative: 5, 15, 18, 20
    // Falls in last bucket (overflow): bucket [100, 200], prevCum=18, count=2
    // fraction = (19-18)/2 = 0.5, result = 100 + 0.5 * 100 = 150
    const result = computePercentileFromHistogramBuckets(
      [10, 50, 100],
      [5, 10, 3, 2],
      0.95,
    );
    expect(result).toBeCloseTo(150, 0);
  });

  it("handles all observations in first bucket", () => {
    // All 10 in [0, 50]
    const result = computePercentileFromHistogramBuckets(
      [50, 100],
      [10, 0, 0],
      0.5,
    );
    // p50 target: 5, fraction = 5/10 = 0.5, result = 0 + 0.5 * 50 = 25
    expect(result).toBeCloseTo(25, 0);
  });

  it("handles single-boundary histogram", () => {
    // Boundaries: [100], Counts: [0, 5]
    // All observations in overflow bucket [100, 200]
    // p50 target: 2.5, fraction = 2.5/5 = 0.5, result = 100 + 0.5 * 100 = 150
    const result = computePercentileFromHistogramBuckets([100], [0, 5], 0.5);
    expect(result).toBeCloseTo(150, 0);
  });

  it("handles p=0", () => {
    // p0 target: 0, falls in first non-empty bucket at fraction 0
    const result = computePercentileFromHistogramBuckets(
      [10, 50],
      [5, 3, 2],
      0,
    );
    expect(result).toBe(0);
  });
});
