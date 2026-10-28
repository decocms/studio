import { describe, expect, it } from "bun:test";
import { spread, weightedMean } from "./aggregate";

describe("weightedMean", () => {
  it("weights each site by its size", () => {
    expect(
      weightedMean([
        { title: "Norte", value: 38, weight: 77_000 },
        { title: "Sul", value: 44, weight: 25_000 },
      ]),
    ).toBeCloseTo(39.47, 2);
  });

  it("is null when nothing carries weight", () => {
    expect(weightedMean([])).toBeNull();
    expect(weightedMean([{ title: "A", value: 10, weight: 0 }])).toBeNull();
  });
});

describe("spread", () => {
  const pct = (v: number) => `${v}%`;
  it("says nothing for a single site", () => {
    expect(spread([{ title: "A", value: 1, weight: 1 }], pct, true)).toBeNull();
  });

  it("names every site up to three", () => {
    expect(
      spread(
        [
          { title: "Norte", value: 38, weight: 1 },
          { title: "Sul", value: 44, weight: 1 },
        ],
        pct,
        true,
      ),
    ).toEqual({ kind: "all", items: ["Norte 38%", "Sul 44%"] });
  });

  it("keeps the best and worst past three, by the metric's direction", () => {
    const values = [
      { title: "A", value: 40, weight: 1 },
      { title: "B", value: 30, weight: 1 },
      { title: "C", value: 50, weight: 1 },
      { title: "D", value: 45, weight: 1 },
    ];
    expect(spread(values, pct, true)).toEqual({
      kind: "range",
      best: "B 30%",
      worst: "C 50%",
    });
    expect(spread(values, pct, false)).toEqual({
      kind: "range",
      best: "C 50%",
      worst: "B 30%",
    });
  });
});
