import { describe, expect, test } from "bun:test";
import { ActiveGaugeTracker } from "./active-gauge-tracker";

describe("ActiveGaugeTracker", () => {
  test("consume returns false for a handle that was never marked counted", () => {
    const tracker = new ActiveGaugeTracker();
    expect(tracker.consume("h1")).toBe(false);
  });

  test("consume returns true exactly once for a marked handle", () => {
    const tracker = new ActiveGaugeTracker();
    tracker.markCounted("h1");
    expect(tracker.consume("h1")).toBe(true);
    expect(tracker.consume("h1")).toBe(false);
  });

  test("tracks multiple handles independently", () => {
    const tracker = new ActiveGaugeTracker();
    tracker.markCounted("h1");
    tracker.markCounted("h2");
    expect(tracker.consume("h1")).toBe(true);
    expect(tracker.consume("h2")).toBe(true);
    expect(tracker.consume("h1")).toBe(false);
  });
});
