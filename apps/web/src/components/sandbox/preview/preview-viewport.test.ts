import { expect, test } from "bun:test";
import { previewViewportLayout } from "./preview-viewport";

test("desktop keeps its breakpoint width as the panel narrows", () => {
  for (const width of [320, 650, 1000]) {
    const { style, fluid } = previewViewportLayout("desktop", {
      width,
      height: 700,
    });
    expect(fluid).toBe(false);
    expect(style.width).toBe("1280px");
    const scale = Number(String(style.transform).slice(6, -1));
    expect(1280 * scale).toBeLessThanOrEqual(width);
    expect(parseFloat(String(style.height)) * scale).toBeCloseTo(700);
  }
});
test("wide desktop fills its canvas and mobile never grows to desktop width", () => {
  expect(
    previewViewportLayout("desktop", { width: 1600, height: 900 }).fluid,
  ).toBe(true);
  expect(
    previewViewportLayout("mobile", { width: 1600, height: 900 }).style.width,
  ).toBe("412px");
});
test("unmeasured and collapsed canvases produce finite styles", () => {
  for (const width of [-1, 0]) {
    for (const device of ["desktop", "mobile", "tablet"] as const) {
      expect(
        JSON.stringify(previewViewportLayout(device, { width, height: 0 })),
      ).not.toMatch(/NaN|Infinity/);
    }
  }
});
