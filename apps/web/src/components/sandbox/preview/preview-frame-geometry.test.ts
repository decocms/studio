import { describe, expect, test } from "bun:test";
import {
  PREVIEW_OFFSET,
  PREVIEW_VIEWPORTS,
  resolvePreviewFrameGeometry,
} from "./preview-frame-geometry";

const desktopOuter = PREVIEW_VIEWPORTS.desktop.width + 2 * PREVIEW_OFFSET;

/**
 * The distinction that matters is fluid vs scaled: scaling a desktop frame
 * that already fits shrinks the page for no reason, and the point of the
 * desktop size is seeing the real responsive layout rather than a miniature.
 */
describe("resolvePreviewFrameGeometry", () => {
  test("desktop fills the canvas while its logical width fits", () => {
    const geometry = resolvePreviewFrameGeometry({
      device: "desktop",
      canvas: { width: 1600, height: 900 },
    });
    expect(geometry.fluid).toBe(true);
    expect(geometry.scale).toBe(1);
    expect(geometry.style).toEqual({ width: "100%", height: "100%" });
  });

  test("desktop fits exactly at its own width, and scales one pixel below", () => {
    expect(
      resolvePreviewFrameGeometry({
        device: "desktop",
        canvas: { width: desktopOuter, height: 900 },
      }).fluid,
    ).toBe(true);
    expect(
      resolvePreviewFrameGeometry({
        device: "desktop",
        canvas: { width: desktopOuter - 1, height: 900 },
      }).fluid,
    ).toBe(false);
  });

  test("an unmeasured canvas reads as fluid rather than scaling against zero", () => {
    const geometry = resolvePreviewFrameGeometry({
      device: "desktop",
      canvas: { width: 0, height: 0 },
    });
    expect(geometry.fluid).toBe(true);
    expect(geometry.scale).toBe(1);
  });

  test("a narrow canvas scales the desktop frame down proportionally", () => {
    const geometry = resolvePreviewFrameGeometry({
      device: "desktop",
      canvas: { width: 641, height: 800 },
    });
    expect(geometry.fluid).toBe(false);
    expect(geometry.scale).toBeCloseTo(641 / desktopOuter, 5);
    expect(geometry.style.width).toBe("1280px");
    expect(geometry.style.transformOrigin).toBe("top center");
  });

  test("mobile and tablet keep their viewport even on a wide canvas", () => {
    for (const device of ["mobile", "tablet"] as const) {
      const geometry = resolvePreviewFrameGeometry({
        device,
        canvas: { width: 3000, height: 900 },
      });
      expect(geometry.fluid).toBe(false);
      // Capped at 1: a wide canvas shows a phone at its own size, not blown up.
      expect(geometry.scale).toBe(1);
      expect(geometry.style.width).toBe(`${PREVIEW_VIEWPORTS[device].width}px`);
    }
  });

  test("the scaled height is divided back out so the page fills the canvas", () => {
    const geometry = resolvePreviewFrameGeometry({
      device: "mobile",
      canvas: { width: 207, height: 400 },
    });
    expect(geometry.style.height).toBe(`${400 / geometry.scale}px`);
  });

  test("an unmeasured height falls back to the device's own", () => {
    expect(
      resolvePreviewFrameGeometry({
        device: "tablet",
        canvas: { width: 500, height: 0 },
      }).style.height,
    ).toBe(`${PREVIEW_VIEWPORTS.tablet.height}px`);
  });
});
