import { describe, expect, it } from "bun:test";
import {
  buildScreenshotOptions,
  buildScreenshotRequestBody,
  jpegHeight,
  validateExternalUrl,
} from "./portable-media-tools";

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

  it("clips to the emulated device's width, not the desktop default", () => {
    const options = buildScreenshotOptions(true, true, {
      width: 390,
      deviceScaleFactor: 1,
    });
    expect(options).toMatchObject({
      clip: { x: 0, y: 0, width: 390, height: 7000 },
    });
  });

  // The clip is CSS px, the returned image is CSS px × scale factor. Clamping
  // to a flat 7000 on a 2× device asks for a 14000px image — over the limit the
  // clamp exists to stay under, so the retry could never succeed.
  it("divides the clip height by the device scale factor", () => {
    const options = buildScreenshotOptions(true, true, {
      width: 390,
      deviceScaleFactor: 2,
    });
    expect(options).toMatchObject({
      clip: { x: 0, y: 0, width: 390, height: 3500 },
    });
  });
});

describe("buildScreenshotRequestBody", () => {
  // Browserless's own `userAgent` field is version-specific (v1 wants a string,
  // v2 wants an object, each 400s on the other); the header form is honored by
  // both. Getting this wrong 400s EVERY mobile capture, so pin the wire shape.
  it("sends a mobile user-agent as a request header, not a `userAgent` field", () => {
    const body = buildScreenshotRequestBody(
      "https://x.test",
      "mobile",
      false,
      false,
    );
    expect(body).not.toHaveProperty("userAgent");
    expect(body.setExtraHTTPHeaders?.["User-Agent"]).toContain("iPhone");
  });

  it("sends no user-agent override for desktop — Chrome's own is correct", () => {
    const body = buildScreenshotRequestBody(
      "https://x.test",
      "desktop",
      false,
      false,
    );
    expect(body).not.toHaveProperty("setExtraHTTPHeaders");
    expect(body).not.toHaveProperty("userAgent");
  });

  it("emulates the phone viewport, touch included", () => {
    const body = buildScreenshotRequestBody(
      "https://x.test",
      "mobile",
      false,
      false,
    );
    expect(body.viewport).toMatchObject({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
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

describe("validateExternalUrl", () => {
  it("rejects loopback", () => {
    expect(() => validateExternalUrl("https://127.0.0.1/x", false)).toThrow();
  });

  // fc00::/7 unique local addresses span fc00::/8 AND fd00::/8.
  it("rejects fc00::/8 unique local addresses, not just fd00::/8", () => {
    expect(() => validateExternalUrl("https://[fc00::1]/x", false)).toThrow();
    expect(() => validateExternalUrl("https://[fd00::1]/x", false)).toThrow();
  });

  it("allows a normal public https URL", () => {
    expect(() =>
      validateExternalUrl("https://example.com/image.png", false),
    ).not.toThrow();
  });
});

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
