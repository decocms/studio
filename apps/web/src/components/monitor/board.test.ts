import { describe, expect, it } from "bun:test";
import {
  groupChannels,
  measureDeploy,
  OTHER_CHANNELS,
  type StoreHours,
} from "./board";

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

describe("groupChannels", () => {
  const channel = (id: string, soFar: number, today: (number | null)[]) => ({
    id,
    name: id.toUpperCase(),
    today,
    d1: today.map((v) => v ?? 0),
    soFar,
    d1SoFar: soFar,
  });

  it("keeps four or fewer channels as they are, busiest first", () => {
    const out = groupChannels([channel("a", 1, [1]), channel("b", 9, [9])]);
    expect(out.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("sums everything past the busiest three into one band", () => {
    const out = groupChannels([
      channel("app", 638, [10, 20]),
      channel("main", 516, [5, 6]),
      channel("soma", 4, [1, null]),
      channel("preview", 7, [2, null]),
      channel("tiktok", 2, [null, null]),
    ]);
    expect(out.map((c) => c.id)).toEqual([
      "app",
      "main",
      "preview",
      OTHER_CHANNELS,
    ]);
    const others = out[3];
    expect(others?.soFar).toBe(6);
    expect(others?.today).toEqual([1, null]);
    expect(others?.name).toBeNull();
  });
});
