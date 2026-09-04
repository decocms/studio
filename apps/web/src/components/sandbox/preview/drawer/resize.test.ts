import { describe, expect, it } from "bun:test";
import {
  clampDrawerHeight,
  drawerHeightForKey,
  DRAWER_KEYBOARD_STEP,
  DRAWER_PREFERRED_MIN_HEIGHT,
  DRAWER_PREFERRED_TOP_RESERVE,
  resolveDrawerResizeRange,
  resolveDrawerResizeMetrics,
} from "./resize";

describe("clampDrawerHeight", () => {
  const PANE = 800;
  const MAX = PANE - DRAWER_PREFERRED_TOP_RESERVE; // 640

  it("passes a value already inside the range through unchanged", () => {
    expect(clampDrawerHeight(400, PANE)).toBe(400);
  });

  it("clamps up to the minimum", () => {
    expect(clampDrawerHeight(10, PANE)).toBe(DRAWER_PREFERRED_MIN_HEIGHT);
    expect(clampDrawerHeight(-50, PANE)).toBe(DRAWER_PREFERRED_MIN_HEIGHT);
  });

  it("clamps down to pane minus the top reserve", () => {
    expect(clampDrawerHeight(5000, PANE)).toBe(MAX);
    expect(clampDrawerHeight(MAX + 1, PANE)).toBe(MAX);
  });

  it("keeps the boundary values", () => {
    expect(clampDrawerHeight(DRAWER_PREFERRED_MIN_HEIGHT, PANE)).toBe(
      DRAWER_PREFERRED_MIN_HEIGHT,
    );
    expect(clampDrawerHeight(MAX, PANE)).toBe(MAX);
  });

  it("contracts both bounds instead of starving a tiny routed body", () => {
    expect(clampDrawerHeight(500, 100)).toBe(45);
    expect(clampDrawerHeight(10, 100)).toBe(45);
  });

  it("honors a custom reserve", () => {
    expect(clampDrawerHeight(5000, 800, 300)).toBe(500);
  });
});

describe("resolveDrawerResizeRange", () => {
  it("keeps the comfortable bounds in a normal-height pane", () => {
    expect(resolveDrawerResizeRange(800)).toEqual({
      minHeight: DRAWER_PREFERRED_MIN_HEIGHT,
      maxHeight: 640,
    });
  });

  it("gives the routed surface a majority of a constrained pane", () => {
    expect(resolveDrawerResizeRange(200)).toEqual({
      minHeight: 90,
      maxHeight: 90,
    });
  });

  it("returns a feasible zero range when no height is available", () => {
    expect(resolveDrawerResizeRange(0)).toEqual({
      minHeight: 0,
      maxHeight: 0,
    });
  });
});

describe("drawerHeightForKey", () => {
  const PANE = 800;
  const MAX = PANE - DRAWER_PREFERRED_TOP_RESERVE;

  it("grows upward and shrinks downward by the keyboard step", () => {
    expect(drawerHeightForKey("ArrowUp", 300, PANE)).toBe(
      300 + DRAWER_KEYBOARD_STEP,
    );
    expect(drawerHeightForKey("ArrowDown", 300, PANE)).toBe(
      300 - DRAWER_KEYBOARD_STEP,
    );
  });

  it("moves to the bounds with Home and End", () => {
    expect(drawerHeightForKey("Home", 300, PANE)).toBe(
      DRAWER_PREFERRED_MIN_HEIGHT,
    );
    expect(drawerHeightForKey("End", 300, PANE)).toBe(MAX);
  });

  it("clamps arrow movement at both bounds", () => {
    expect(
      drawerHeightForKey("ArrowDown", DRAWER_PREFERRED_MIN_HEIGHT, PANE),
    ).toBe(DRAWER_PREFERRED_MIN_HEIGHT);
    expect(drawerHeightForKey("ArrowUp", MAX, PANE)).toBe(MAX);
  });

  it("uses the adaptive bounds for Home and End in a tiny pane", () => {
    expect(drawerHeightForKey("Home", 80, 100)).toBe(45);
    expect(drawerHeightForKey("End", 80, 100)).toBe(45);
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
      minHeight: DRAWER_PREFERRED_MIN_HEIGHT,
      maxHeight: 640,
    });
    expect(resolveDrawerResizeMetrics(10, 800)).toEqual({
      height: DRAWER_PREFERRED_MIN_HEIGHT,
      minHeight: DRAWER_PREFERRED_MIN_HEIGHT,
      maxHeight: 640,
    });
  });

  it("exposes the same contracted range used to render a tiny drawer", () => {
    expect(resolveDrawerResizeMetrics(80, 100)).toEqual({
      height: 45,
      minHeight: 45,
      maxHeight: 45,
    });
  });
});
