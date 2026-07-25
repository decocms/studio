import { describe, expect, test } from "bun:test";
import { HEADER_W, headerLayout } from "./header-layout";

const { lead, tab, middle } = HEADER_W;

describe("headerLayout", () => {
  test("unmeasured widths (-1 sentinel) → fully open", () => {
    expect(headerLayout(-1, -1)).toEqual({ maxTabs: 3 });
    expect(headerLayout(1000, -1)).toEqual({ maxTabs: 3 });
    expect(headerLayout(-1, 200)).toEqual({ maxTabs: 3 });
  });

  test("roomy → 3 tabs", () => {
    // avail = headerWidth - rightWidth must clear lead + 3*tab + middle.
    const avail = lead + 3 * tab + middle;
    expect(headerLayout(avail + 200, 200)).toEqual({ maxTabs: 3 });
  });

  test("degrades to 2 tabs just below the 3-tab threshold", () => {
    const threshold = lead + 3 * tab + middle;
    expect(headerLayout(threshold - 1 + 200, 200)).toEqual({ maxTabs: 2 });
  });

  test("degrades to 1 tab below the 2-tab threshold", () => {
    const threshold = lead + 2 * tab + middle;
    expect(headerLayout(threshold - 1 + 200, 200)).toEqual({ maxTabs: 1 });
  });

  test("1 tab is the floor — never drops to zero, however cramped", () => {
    expect(headerLayout(0, 0)).toEqual({ maxTabs: 1 });
    // A right cluster wider than the whole header (avail goes negative).
    expect(headerLayout(300, 900)).toEqual({ maxTabs: 1 });
  });

  test("exact boundaries are inclusive (monotonic, no flicker-back)", () => {
    expect(headerLayout(lead + 3 * tab + middle, 0).maxTabs).toBe(3);
    expect(headerLayout(lead + 2 * tab + middle, 0).maxTabs).toBe(2);
  });

  test("a wide right cluster eats into avail and forces degradation", () => {
    const headerWidth = lead + 3 * tab + middle;
    // With no right cluster it's 3 tabs; a big right cluster drops it.
    expect(headerLayout(headerWidth, 0).maxTabs).toBe(3);
    expect(headerLayout(headerWidth, tab).maxTabs).toBe(2);
  });

  test("the page selector is no longer decided here — it is a container query", () => {
    // Moved to `@max-sm/panel-header:hidden` in workspace-panel-group, so the
    // budget must not resurrect a showPageSelector field (see PanelHeader).
    expect(headerLayout(100, 0)).not.toHaveProperty("showPageSelector");
    expect(headerLayout(5000, 0)).not.toHaveProperty("showPageSelector");
  });
});
