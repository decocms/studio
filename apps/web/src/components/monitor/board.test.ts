import { describe, expect, it } from "bun:test";
import { measureDeploy, type StoreHours } from "./board";

const HOUR = 3_600_000;
const START = Date.parse("2026-10-20T03:00:00.000Z");

/** A flat week-earlier day of 100 orders an hour; today as given. */
function store(today: (number | null)[], done = 96): StoreHours {
  return { start: START, done, today, w1: Array(24).fill(100) };
}
const flat = (overrides: Record<number, number>) =>
  Array.from({ length: 24 }, (_, h) => overrides[h] ?? 100);

describe("measureDeploy", () => {
  const at = START + 10.5 * HOUR;

  it("is unmeasured without a store", () => {
    expect(measureDeploy(at, []).verdict).toBe("unmeasured");
  });

  it("is unmeasured off the day shown or at its edges", () => {
    const s = store(flat({}));
    expect(measureDeploy(START - HOUR, [s]).verdict).toBe("unmeasured");
    expect(measureDeploy(START + 0.5 * HOUR, [s]).verdict).toBe("unmeasured");
    expect(measureDeploy(START + 23.5 * HOUR, [s]).verdict).toBe("unmeasured");
  });

  it("settles until the hour after is fully in", () => {
    const result = measureDeploy(at, [store(flat({}), 11 * 4)]);
    expect(result.verdict).toBe("settling");
    expect(result.settlesAt).toBe(new Date(START + 12 * HOUR).toISOString());
  });

  it("reads a drop in the hour after as a regression", () => {
    const result = measureDeploy(at, [store(flat({ 11: 50 }))]);
    expect(result.verdict).toBe("regression");
    expect(result.impact[0]?.change).toBeCloseTo(-0.5);
  });

  it("discounts the day's own curve with the week before", () => {
    const s = { ...store(flat({ 11: 200 })), w1: flat({ 11: 200 }) };
    expect(measureDeploy(at, [s]).verdict).toBe("neutral");
  });

  it("calls a rise an improvement and sums stores", () => {
    const result = measureDeploy(at, [
      store(flat({ 11: 150 })),
      store(flat({ 11: 150 })),
    ]);
    expect(result.verdict).toBe("improvement");
  });

  it("is unmeasured when the hour before is too quiet to judge", () => {
    expect(measureDeploy(at, [store(flat({ 9: 3 }))]).verdict).toBe(
      "unmeasured",
    );
  });
});
