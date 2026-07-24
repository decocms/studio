import { test, expect } from "bun:test";
import {
  RACK_SCAN_DELAYS,
  RACK_SCAN_PERIOD_SEC,
  RACK_SLOT_COUNT,
  RESERVED_SLOT_INDEX,
} from "./provision-rack";

test("RACK_SLOT_COUNT is 48 (8×6 grid)", () => {
  expect(RACK_SLOT_COUNT).toBe(48);
});

test("RESERVED_SLOT_INDEX is within the grid", () => {
  expect(RESERVED_SLOT_INDEX).toBeGreaterThanOrEqual(0);
  expect(RESERVED_SLOT_INDEX).toBeLessThan(RACK_SLOT_COUNT);
});

test("RACK_SCAN_DELAYS has one entry per slot, null at reserved index", () => {
  expect(RACK_SCAN_DELAYS).toHaveLength(RACK_SLOT_COUNT);
  expect(RACK_SCAN_DELAYS[RESERVED_SLOT_INDEX]).toBeNull();
});

test("non-reserved tiles get strictly increasing delays starting at 0", () => {
  const nonNull = RACK_SCAN_DELAYS.filter((d): d is number => d !== null);
  expect(nonNull).toHaveLength(RACK_SLOT_COUNT - 1);
  expect(nonNull[0]).toBe(0);
  for (let i = 1; i < nonNull.length; i++) {
    expect(nonNull[i]).toBeGreaterThan(nonNull[i - 1] as number);
  }
});

test("delays are evenly spaced across the scan period", () => {
  const nonNull = RACK_SCAN_DELAYS.filter((d): d is number => d !== null);
  const step = RACK_SCAN_PERIOD_SEC / (RACK_SLOT_COUNT - 1);
  nonNull.forEach((delay, i) => {
    expect(delay).toBeCloseTo(i * step, 5);
  });
});
