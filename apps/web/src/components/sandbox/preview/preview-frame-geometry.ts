import type { CSSProperties } from "react";
import type { PreviewDeviceSize } from "./device-hint";

/**
 * Logical viewport dimensions per device, matching the legacy admin. The iframe
 * renders the page at this fixed logical size and is then scaled down with a
 * CSS transform to fit the available canvas width — so widening the blocks
 * panel shrinks a faithful proportional miniature of the full layout instead of
 * reflowing the responsive breakpoints (desktop) or clipping the frame
 * (mobile/tablet).
 */
export const PREVIEW_VIEWPORTS: Record<
  PreviewDeviceSize,
  { width: number; height: number }
> = {
  mobile: { width: 412, height: 823 }, // Moto G Power
  tablet: { width: 1024, height: 1366 }, // iPad Pro
  desktop: { width: 1280, height: 800 }, // MacBook Pro 14
};

/** Px inset so the scaled frame's border doesn't sit flush against the canvas edge. */
export const PREVIEW_OFFSET = 1;

export interface PreviewFrameGeometry {
  /**
   * The frame fills the canvas at its natural size, so the page lays out
   * against real breakpoints. Callers drop the frame's border in this state —
   * there is no miniature to outline.
   */
  fluid: boolean;
  scale: number;
  style: CSSProperties;
}

/**
 * How the preview frame occupies its canvas.
 *
 * Desktop stays FLUID while the canvas can hold its logical width: scaling a
 * 1280px frame into a 1280px canvas would shrink the page for no reason, and
 * the point of desktop is to see the real responsive layout. Below that — and
 * always for mobile/tablet, whose whole purpose is the narrow viewport — the
 * frame keeps its logical size and scales to fit.
 *
 * A canvas width of `0` means "not measured yet" and reads as fluid, so the
 * first paint is not a frame scaled against a width nobody has reported. The
 * scale is capped at 1, so a canvas wider than a phone shows the phone at its
 * own size rather than blown up.
 */
export function resolvePreviewFrameGeometry(input: {
  device: PreviewDeviceSize;
  canvas: { width: number; height: number };
}): PreviewFrameGeometry {
  const viewport = PREVIEW_VIEWPORTS[input.device];
  const outerWidth = viewport.width + 2 * PREVIEW_OFFSET;
  const fluid =
    input.device === "desktop" &&
    (input.canvas.width === 0 || input.canvas.width >= outerWidth);

  if (fluid) {
    return { fluid, scale: 1, style: { width: "100%", height: "100%" } };
  }

  const scale =
    input.canvas.width > 0 ? Math.min(input.canvas.width / outerWidth, 1) : 1;

  return {
    fluid,
    scale,
    style: {
      width: `${viewport.width}px`,
      /** Divided back out, so the scaled page fills the canvas height. */
      height:
        input.canvas.height > 0
          ? `${input.canvas.height / scale}px`
          : `${viewport.height}px`,
      transform: `scale(${scale})`,
      transformOrigin: "top center",
    },
  };
}
