import { describe, expect, it } from "bun:test";
import type { MetricPoint } from "./board";
import { byHour } from "./metric-chart";

const point = (
  bucket: number,
  value: number | null,
  band?: [number, number],
): MetricPoint => ({ bucket, value, d1: 1, w1: 2, y1: null, band });

describe("byHour", () => {
  it("adds up a count's buckets and averages a rate's", () => {
    const points = [point(13, 4), point(12, 2), point(0, 1)];
    expect(byHour(points, false).map((p) => [p.hour, p.value])).toEqual([
      [0, 1],
      [1, 6],
    ]);
    expect(byHour(points, true).map((p) => p.value)).toEqual([1, 3]);
    expect(byHour(points, false)[1]?.refs).toEqual({ d1: 2, w1: 4, y1: null });
  });

  it("keeps an hour with nothing in it as a gap", () => {
    expect(byHour([point(6, null)], false)[0]?.value).toBeNull();
  });

  it("orders a band low to high, whichever way the rule points", () => {
    expect(byHour([point(6, 5, [10, 4])], false)[0]?.band).toEqual([4, 10]);
    expect(byHour([point(6, 5)], false)[0]?.band).toBeNull();
  });
});
