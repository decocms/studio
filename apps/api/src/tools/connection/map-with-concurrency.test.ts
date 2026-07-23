import { describe, expect, test } from "bun:test";
import { mapWithConcurrency } from "./map-with-concurrency";

describe("mapWithConcurrency", () => {
  test("processes every item exactly once", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const seen: number[] = [];
    await mapWithConcurrency(items, 8, async (i) => {
      seen.push(i);
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  test("never exceeds the concurrency limit", async () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(items, 5, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield so multiple workers overlap before any resolves.
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(5);
  });

  test("caps workers at item count when fewer items than concurrency", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2], 16, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("is a no-op for an empty list", async () => {
    let calls = 0;
    await mapWithConcurrency([], 8, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });
});
