import { describe, expect, it } from "bun:test";
import { animatedImageArea } from "./animated-image-area";

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// 4×3, 3 frames — generated with ImageMagick.
const ANIMATED_GIF = b64(
  "R0lGODlhBAADAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAABAADAAACA4SPVgAh+QQACgAAACwAAAAABAADAIAAAP8AAAACA4SPVgAh+QQACgAAACwAAAAABAADAIAAgAAAAAACA4SPVgA7",
);
const ANIMATED_WEBP = b64(
  "UklGRgwBAABXRUJQVlA4WAoAAAACAAAAAwAAAgAAQU5JTQYAAAD/////AABBTk1GSAAAAAAAAAAAAAMAAAIAAGQAAAJWUDggMAAAANABAJ0BKgQAAwACADQloAJ0ugH4AAOwAP7wxAv/ILlhdcjX/yA/5Af8gP/48gAAAEFOTUZEAAAAAAAAAAAAAwAAAgAAZAAAAFZQOCAsAAAAlAEAnQEqBAADAAAANCWgAnS6AAOYAP75k2//kB//kB//kB//ID/iF3sgMABBTk1GRAAAAAAAAAAAAAMAAAIAAGQAAABWUDggLAAAANQBAJ0BKgQAAwAAADQloAJ0ugH4AAOwAP7w6Pf/ILlhdcjX/mwK5rn5qAAA",
);
const STATIC_WEBP = b64(
  "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoEAAMAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=",
);
const STATIC_GIF = b64(
  "R0lGODlhBAADAPAAAP8AAAAAACH5BAAAAAAALAAAAAAEAAMAAAIDhI9WADs=",
);

describe("animatedImageArea", () => {
  it("counts frames × canvas for an animated GIF", () => {
    expect(animatedImageArea(ANIMATED_GIF)).toEqual({
      width: 4,
      height: 3,
      frames: 3,
      megapixels: 36 / 1e6,
    });
  });

  it("counts frames × canvas for an animated WebP", () => {
    expect(animatedImageArea(ANIMATED_WEBP)).toEqual({
      width: 4,
      height: 3,
      frames: 3,
      megapixels: 36 / 1e6,
    });
  });

  it("ignores still images", () => {
    expect(animatedImageArea(STATIC_WEBP)).toBeNull();
    expect(animatedImageArea(STATIC_GIF)).toBeNull();
  });

  it("ignores non-GIF/WebP and truncated input", () => {
    expect(animatedImageArea(new Uint8Array(40))).toBeNull();
    expect(animatedImageArea(ANIMATED_WEBP.subarray(0, 10))).toBeNull();
  });
});
