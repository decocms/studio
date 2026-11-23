import { describe, expect, it } from "bun:test";
import type { OrderMonitorForecast } from "@decocms/shared/order-monitor";
import { bands } from "./sales-status";

const hours = (end: number) =>
  Array.from({ length: 24 }, (_, h) => (h === 23 ? end : 0));

/** A store whose reference days each closed the rest of the day at `ends[daysAgo]`. */
const store = (ends: Record<number, number>, ahead = 0) =>
  ({
    orders: hours(ahead),
    revenue: hours(ahead),
    close: { orders: 0, revenue: 0 },
    initial: { orders: 0, revenue: 0 },
    paths: Object.entries(ends).map(([d, end]) => ({
      daysAgo: Number(d),
      orders: hours(end),
      revenue: hours(end),
    })),
  }) satisfies OrderMonitorForecast;

describe("bands", () => {
  it("adds stores up day by day, so their busy days don't all stack", () => {
    // Each store had one big day, on different days: summing highs gave 300.
    const b = bands(
      [store({ 1: 100, 7: 10, 14: 10 }), store({ 1: 10, 7: 100, 14: 10 })],
      "orders",
    )!;
    expect(b.outer.high[23]).toBeLessThan(200);
    expect(b.outer.low[23]).toBeGreaterThanOrEqual(20);
    expect(b.inner.low[23]).toBeGreaterThanOrEqual(b.outer.low[23]!);
    expect(b.inner.high[23]).toBeLessThanOrEqual(b.outer.high[23]!);
  });

  it("stands a store's projection in for a day it lacks", () => {
    const b = bands([store({ 1: 50 }), store({}, 30)], "orders")!;
    expect(b.inner.low[23]).toBe(80);
  });

  it("has no bands without any reference day", () => {
    expect(bands([store({})], "orders")).toBeNull();
  });
});
