import { describe, expect, it } from "bun:test";
import {
  clampDrawerHeight,
  drawerHeightForKey,
  DRAWER_KEYBOARD_STEP,
  DRAWER_MIN_HEIGHT,
  DRAWER_TOP_RESERVE,
  resolveDrawerResizeMetrics,
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

describe("drawerHeightForKey", () => {
  const PANE = 800;
  const MAX = PANE - DRAWER_TOP_RESERVE;

  it("grows upward and shrinks downward by the keyboard step", () => {
    expect(drawerHeightForKey("ArrowUp", 300, PANE)).toBe(
      300 + DRAWER_KEYBOARD_STEP,
    );
    expect(drawerHeightForKey("ArrowDown", 300, PANE)).toBe(
      300 - DRAWER_KEYBOARD_STEP,
    );
  });

  it("moves to the bounds with Home and End", () => {
    expect(drawerHeightForKey("Home", 300, PANE)).toBe(DRAWER_MIN_HEIGHT);
    expect(drawerHeightForKey("End", 300, PANE)).toBe(MAX);
  });

  it("clamps arrow movement at both bounds", () => {
    expect(drawerHeightForKey("ArrowDown", DRAWER_MIN_HEIGHT, PANE)).toBe(
      DRAWER_MIN_HEIGHT,
    );
    expect(drawerHeightForKey("ArrowUp", MAX, PANE)).toBe(MAX);
  });

  it("ignores keys outside the separator contract", () => {
    expect(drawerHeightForKey("Enter", 300, PANE)).toBeNull();
    expect(drawerHeightForKey("PageUp", 300, PANE)).toBeNull();
  });
});

describe("resolveDrawerResizeMetrics", () => {
  it("keeps the exposed value within the same bounds as pointer resizing", () => {
    expect(resolveDrawerResizeMetrics(5_000, 800)).toEqual({
      height: 640,
      maxHeight: 640,
    });
    expect(resolveDrawerResizeMetrics(10, 800)).toEqual({
      height: DRAWER_MIN_HEIGHT,
      maxHeight: 640,
    });
  });

  it("collapses both ends to the minimum for a tiny pane", () => {
    expect(resolveDrawerResizeMetrics(80, 100)).toEqual({
      height: DRAWER_MIN_HEIGHT,
      maxHeight: DRAWER_MIN_HEIGHT,
    });
  });
});
