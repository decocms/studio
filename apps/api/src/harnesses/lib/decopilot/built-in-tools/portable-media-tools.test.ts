import { describe, expect, it } from "bun:test";
import { buildScreenshotOptions, jpegHeight } from "./portable-media-tools";

describe("buildScreenshotOptions", () => {
  it("captures the viewport when fullPage is off", () => {
    expect(buildScreenshotOptions(false)).toMatchObject({ fullPage: false });
  });

  it("captures the whole page on the first attempt", () => {
    expect(buildScreenshotOptions(true)).toMatchObject({ fullPage: true });
  });

  it("clips instead of fullPage on the clamped retry — they are exclusive", () => {
    const options = buildScreenshotOptions(true, true);
    expect(options).not.toHaveProperty("fullPage");
    expect(options).toMatchObject({
      clip: { x: 0, y: 0, width: 1280, height: 7000 },
    });
  });

  it("clamps to the emulated device width — mobile clips to the phone width", () => {
    const options = buildScreenshotOptions(true, true, 390);
    expect(options).toMatchObject({
      clip: { x: 0, y: 0, width: 390, height: 7000 },
    });
  });
});

/** Minimal JPEG: SOI, an APP0 segment to skip over, then SOF0 with dimensions. */
function jpegWith(height: number, width = 1280): Uint8Array {
  const sof = [
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ];
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    ...sof,
  ]);
}

describe("jpegHeight", () => {
  it("reads the height past intervening segments", () => {
    expect(jpegHeight(jpegWith(842))).toBe(842);
  });

  it("reads heights above the 8000px ceiling that broke thrd_uY3x6c0d", () => {
    expect(jpegHeight(jpegWith(21_314))).toBe(21_314);
  });

  it("returns null for non-JPEG bytes rather than guessing", () => {
    expect(jpegHeight(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it("returns null on a truncated file", () => {
    expect(jpegHeight(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
  });
});
