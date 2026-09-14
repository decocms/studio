/**
 * Geometry and encoding for the image cropper.
 *
 * Kept apart from the component so the arithmetic — the part that is easy to
 * get subtly wrong and impossible to eyeball in a screenshot — is unit
 * testable without a DOM.
 */

/** Pan offset of the image centre from the viewport centre, in CSS pixels. */
export interface Offset {
  x: number;
  y: number;
}

export interface CropGeometry {
  /** Natural pixel dimensions of the source image. */
  imageWidth: number;
  imageHeight: number;
  /** Side of the (square) crop viewport, in CSS pixels. */
  viewport: number;
  /** 1 = the image exactly covers the viewport. */
  zoom: number;
  offset: Offset;
}

/** Source rectangle, in the image's own pixels, that the viewport shows. */
export interface SourceRect {
  sx: number;
  sy: number;
  size: number;
}

/**
 * Scale at which the image exactly covers the viewport. Zoom multiplies this,
 * so zoom 1 always means "no empty corners" whatever the source aspect is.
 */
export function coverScale(g: {
  imageWidth: number;
  imageHeight: number;
  viewport: number;
}): number {
  return Math.max(g.viewport / g.imageWidth, g.viewport / g.imageHeight);
}

/**
 * Largest pan, per axis, that keeps the image covering the viewport. Zero when
 * the axis has no slack, which is the case for one axis at zoom 1.
 */
export function maxOffset(g: CropGeometry): Offset {
  const scale = coverScale(g) * g.zoom;
  return {
    x: Math.max(0, (g.imageWidth * scale - g.viewport) / 2),
    y: Math.max(0, (g.imageHeight * scale - g.viewport) / 2),
  };
}

/** Pan clamped so dragging can never reveal a blank edge. */
export function clampOffset(g: CropGeometry): Offset {
  const max = maxOffset(g);
  return {
    x: Math.min(max.x, Math.max(-max.x, g.offset.x)),
    y: Math.min(max.y, Math.max(-max.y, g.offset.y)),
  };
}

/**
 * The visible square in source-image pixels.
 *
 * The image is drawn centred on the viewport centre, displaced by `offset`, at
 * `coverScale * zoom`. Inverting that maps the viewport's top-left corner back
 * into image space. The result is clamped because floating-point drift at the
 * extremes could otherwise ask `drawImage` for a pixel outside the bitmap.
 */
export function sourceRect(g: CropGeometry): SourceRect {
  const scale = coverScale(g) * g.zoom;
  const offset = clampOffset(g);
  const size = g.viewport / scale;
  const sx = g.imageWidth / 2 - size / 2 - offset.x / scale;
  const sy = g.imageHeight / 2 - size / 2 - offset.y / scale;
  return {
    sx: Math.min(Math.max(0, sx), Math.max(0, g.imageWidth - size)),
    sy: Math.min(Math.max(0, sy), Math.max(0, g.imageHeight - size)),
    size,
  };
}

/**
 * Side of the encoded output. Capped so a phone photo lands as a small square
 * instead of a multi-megabyte upload, and never upscaled past the source —
 * enlarging pixels only makes the file bigger.
 */
export function outputSize(rect: SourceRect, max: number): number {
  return Math.max(1, Math.round(Math.min(max, rect.size)));
}
