import { describe, expect, it } from "bun:test";
import {
  clampOffset,
  coverScale,
  maxOffset,
  outputSize,
  sourceRect,
  type CropGeometry,
} from "./crop";

/** A 400×200 landscape source in a 100px viewport. */
const landscape: CropGeometry = {
  imageWidth: 400,
  imageHeight: 200,
  viewport: 100,
  zoom: 1,
  offset: { x: 0, y: 0 },
};

describe("coverScale", () => {
  it("fits the short edge, so there are no blank corners", () => {
    expect(coverScale(landscape)).toBe(0.5);
    expect(
      coverScale({ ...landscape, imageWidth: 200, imageHeight: 400 }),
    ).toBe(0.5);
  });

  it("scales a source smaller than the viewport up to cover it", () => {
    expect(coverScale({ ...landscape, imageWidth: 50, imageHeight: 50 })).toBe(
      2,
    );
  });
});

describe("maxOffset", () => {
  it("gives slack only on the long axis at zoom 1", () => {
    expect(maxOffset(landscape)).toEqual({ x: 50, y: 0 });
  });

  it("opens up both axes once zoomed in", () => {
    expect(maxOffset({ ...landscape, zoom: 2 })).toEqual({ x: 150, y: 50 });
  });

  it("has no slack at all for a square source at zoom 1", () => {
    expect(
      maxOffset({ ...landscape, imageWidth: 200, imageHeight: 200 }),
    ).toEqual({ x: 0, y: 0 });
  });
});

describe("clampOffset", () => {
  it("holds a drag at the edge instead of revealing blank space", () => {
    expect(clampOffset({ ...landscape, offset: { x: 999, y: 999 } })).toEqual({
      x: 50,
      y: 0,
    });
    expect(clampOffset({ ...landscape, offset: { x: -999, y: -999 } })).toEqual(
      { x: -50, y: -0 },
    );
  });

  it("leaves an in-range pan alone", () => {
    expect(clampOffset({ ...landscape, offset: { x: 20, y: 0 } })).toEqual({
      x: 20,
      y: 0,
    });
  });
});

describe("sourceRect", () => {
  it("takes the centre square of a landscape source at rest", () => {
    expect(sourceRect(landscape)).toEqual({ sx: 100, sy: 0, size: 200 });
  });

  it("panning right selects pixels further left in the source", () => {
    expect(sourceRect({ ...landscape, offset: { x: 50, y: 0 } })).toEqual({
      sx: 0,
      sy: 0,
      size: 200,
    });
  });

  it("zooming in narrows the source square around the centre", () => {
    expect(sourceRect({ ...landscape, zoom: 2 })).toEqual({
      sx: 150,
      sy: 50,
      size: 100,
    });
  });

  it("never runs off the bitmap, even asking for an impossible pan", () => {
    const r = sourceRect({ ...landscape, offset: { x: -1e6, y: -1e6 } });
    expect(r.sx).toBeGreaterThanOrEqual(0);
    expect(r.sy).toBeGreaterThanOrEqual(0);
    expect(r.sx + r.size).toBeLessThanOrEqual(landscape.imageWidth);
    expect(r.sy + r.size).toBeLessThanOrEqual(landscape.imageHeight);
  });
});

describe("outputSize", () => {
  it("caps a large crop", () => {
    expect(outputSize({ sx: 0, sy: 0, size: 2000 }, 512)).toBe(512);
  });

  it("does not upscale a crop smaller than the cap", () => {
    expect(outputSize({ sx: 0, sy: 0, size: 120 }, 512)).toBe(120);
  });

  it("never returns a zero-sized canvas", () => {
    expect(outputSize({ sx: 0, sy: 0, size: 0.2 }, 512)).toBe(1);
  });
});
