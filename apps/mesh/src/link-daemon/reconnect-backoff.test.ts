import { describe, expect, test } from "bun:test";
import {
  computeBackoffMs,
  shouldReconnectOnClose,
  WS_CLOSE_SUPERSEDED,
} from "./reconnect-backoff";

describe("computeBackoffMs", () => {
  test("first attempt is ~base (500ms ± jitter)", () => {
    const ms = computeBackoffMs(1);
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThanOrEqual(500);
  });

  test("grows exponentially", () => {
    expect(computeBackoffMs(2)).toBeLessThanOrEqual(1_000);
    expect(computeBackoffMs(2)).toBeGreaterThanOrEqual(500);
    expect(computeBackoffMs(3)).toBeLessThanOrEqual(2_000);
  });

  test("caps at 30s", () => {
    expect(computeBackoffMs(20)).toBeLessThanOrEqual(30_000);
    expect(computeBackoffMs(20)).toBeGreaterThanOrEqual(15_000);
  });

  test("attempt 0 throws (we count from 1)", () => {
    expect(() => computeBackoffMs(0)).toThrow();
  });
});

describe("shouldReconnectOnClose", () => {
  test("returns true for normal disconnects", () => {
    expect(shouldReconnectOnClose(1006)).toBe(true); // abnormal closure
    expect(shouldReconnectOnClose(1001)).toBe(true); // going away
    expect(shouldReconnectOnClose(1011)).toBe(true); // server error
  });

  test("returns true for clean close 1000", () => {
    // Generic 1000 happens on transient drops; reconnect.
    expect(shouldReconnectOnClose(1000)).toBe(true);
  });

  test("returns false for 4001 superseded", () => {
    expect(shouldReconnectOnClose(WS_CLOSE_SUPERSEDED)).toBe(false);
    expect(shouldReconnectOnClose(4001)).toBe(false);
  });
});
