import { describe, expect, it } from "bun:test";
import {
  clampDrawerHeight,
  DRAWER_MIN_HEIGHT,
  DRAWER_TOP_RESERVE,
} from "./resize";

describe("clampDrawerHeight", () => {
  const PANE = 800;
  const MAX = PANE - DRAWER_TOP_RESERVE; // 640

  it("passes a value already inside the range through unchanged", () => {
    expect(clampDrawerHeight(400, PANE)).toBe(400);
  });

  it("clamps up to the minimum", () => {
    expect(clampDrawerHeight(10, PANE)).toBe(DRAWER_MIN_HEIGHT);
    expect(clampDrawerHeight(-50, PANE)).toBe(DRAWER_MIN_HEIGHT);
  });

  it("clamps down to pane minus the top reserve", () => {
    expect(clampDrawerHeight(5000, PANE)).toBe(MAX);
    expect(clampDrawerHeight(MAX + 1, PANE)).toBe(MAX);
  });

  it("keeps the boundary values", () => {
    expect(clampDrawerHeight(DRAWER_MIN_HEIGHT, PANE)).toBe(DRAWER_MIN_HEIGHT);
    expect(clampDrawerHeight(MAX, PANE)).toBe(MAX);
  });

  it("never inverts the range on a pane too short for the reserve", () => {
    // paneHeight - reserve would be below the min → collapse to the min, and
    // any proposed height resolves to exactly the min (never a negative cap).
    expect(clampDrawerHeight(500, 100)).toBe(DRAWER_MIN_HEIGHT);
    expect(clampDrawerHeight(10, 100)).toBe(DRAWER_MIN_HEIGHT);
  });

  it("honors a custom reserve", () => {
    expect(clampDrawerHeight(5000, 800, 300)).toBe(500);
  });
});
