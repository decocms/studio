import { describe, expect, test } from "bun:test";
import { HEADER_W, headerLayout } from "./header-layout";

const { lead, tab, middle } = HEADER_W;

describe("headerLayout", () => {
  test("unmeasured widths (-1 sentinel) → fully open", () => {
    expect(headerLayout(-1, -1)).toEqual({
      maxTabs: 3,
      showPageSelector: true,
    });
    expect(headerLayout(1000, -1)).toEqual({
      maxTabs: 3,
      showPageSelector: true,
    });
    expect(headerLayout(-1, 200)).toEqual({
      maxTabs: 3,
      showPageSelector: true,
    });
  });

  test("roomy → 3 tabs + selector", () => {
    // avail = headerWidth - rightWidth must clear lead + 3*tab + middle.
    const avail = lead + 3 * tab + middle;
    expect(headerLayout(avail + 200, 200)).toEqual({
      maxTabs: 3,
      showPageSelector: true,
    });
  });

  test("degrades to 2 tabs just below the 3-tab threshold", () => {
    const threshold = lead + 3 * tab + middle;
    expect(headerLayout(threshold - 1 + 200, 200)).toEqual({
      maxTabs: 2,
      showPageSelector: true,
    });
  });

  test("degrades to 1 tab below the 2-tab threshold", () => {
    const threshold = lead + 2 * tab + middle;
    expect(headerLayout(threshold - 1 + 200, 200)).toEqual({
      maxTabs: 1,
      showPageSelector: true,
    });
  });

  test("hides the page selector below the 1-tab+selector threshold", () => {
    const threshold = lead + 1 * tab + middle;
    expect(headerLayout(threshold - 1 + 200, 200)).toEqual({
      maxTabs: 1,
      showPageSelector: false,
    });
  });

  test("exact boundaries are inclusive (monotonic, no flicker-back)", () => {
    expect(headerLayout(lead + 3 * tab + middle, 0).maxTabs).toBe(3);
    expect(headerLayout(lead + 2 * tab + middle, 0).maxTabs).toBe(2);
    expect(headerLayout(lead + 1 * tab + middle, 0)).toEqual({
      maxTabs: 1,
      showPageSelector: true,
    });
  });

  test("a wide right cluster eats into avail and forces degradation", () => {
    const headerWidth = lead + 3 * tab + middle;
    // With no right cluster it's 3 tabs; a big right cluster drops it.
    expect(headerLayout(headerWidth, 0).maxTabs).toBe(3);
    expect(headerLayout(headerWidth, tab).maxTabs).toBe(2);
  });
});
