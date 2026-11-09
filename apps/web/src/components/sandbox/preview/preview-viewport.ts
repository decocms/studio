import type { CSSProperties } from "react";

const VIEWPORTS = {
  mobile: { width: 412, height: 823 },
  tablet: { width: 1024, height: 1366 },
  desktop: { width: 1280, height: 800 },
};

/** Keep responsive breakpoints stable when a narrow panel scales the preview. */
export function previewViewportLayout(
  device: keyof typeof VIEWPORTS,
  canvas: { width: number; height: number },
): { fluid: boolean; style: CSSProperties } {
  const viewport = VIEWPORTS[device];
  const inset = 1;
  const fluid =
    device === "desktop" &&
    (canvas.width <= 0 || canvas.width >= viewport.width + 2 * inset);
  const scale = fluid
    ? 1
    : Math.min(
        canvas.width > 0 ? canvas.width / (viewport.width + 2 * inset) : 1,
        1,
      );
  return {
    fluid,
    style: fluid
      ? { width: "100%", height: "100%" }
      : {
          width: `${viewport.width}px`,
          height: `${canvas.height > 0 ? canvas.height / scale : viewport.height}px`,
          transform: `scale(${scale})`,
          transformOrigin: "top center",
        },
  };
}
