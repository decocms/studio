import { describe, expect, test } from "bun:test";
import {
  contrastRatio,
  enforceContrast,
  ensureSurfaceDistinct,
  parseHex,
} from "./contrast";

const hex = (h: string) => parseHex(h)!;

describe("contrast utilities", () => {
  test("WCAG ratios match known anchors", () => {
    // Black on white = 21:1
    expect(contrastRatio(hex("#000000"), hex("#FFFFFF"))).toBeCloseTo(21, 0);
    // Same color = 1:1
    expect(contrastRatio(hex("#777777"), hex("#777777"))).toBeCloseTo(1, 5);
  });

  test("enforceContrast leaves passing colors alone", () => {
    const fg = "#0A0A0A";
    expect(enforceContrast(fg, "#FFFFFF", { minRatio: 4.5 })).toBe(fg);
  });

  test("enforceContrast pulls a too-light muted toward fg on a light bg", () => {
    // muted is pastel pink ~ #FFB6C1; bg cream ~ #FFFAF0 → low contrast
    const muted = "#FFB6C1";
    const bg = "#FFFAF0";
    const corrected = enforceContrast(muted, bg, {
      minRatio: 4.5,
      toward: "#1A1A1A",
    });
    expect(contrastRatio(hex(corrected), hex(bg))).toBeGreaterThanOrEqual(4.5);
    // Should not be a totally different color — luminance has moved, but
    // it shouldn't be pure black.
    expect(corrected).not.toBe("#000000");
  });

  test("enforceContrast pulls a too-dark muted toward fg on a dark bg", () => {
    // muted ~ slightly darker than bg
    const muted = "#1A1A22";
    const bg = "#0B0B12";
    const corrected = enforceContrast(muted, bg, {
      minRatio: 4.5,
      toward: "#F6F6F8",
    });
    expect(contrastRatio(hex(corrected), hex(bg))).toBeGreaterThanOrEqual(4.5);
  });

  test("border threshold is lower (1.5:1) — keeps subtle dividers", () => {
    const border = "#2A2A36";
    const bg = "#0B0B12";
    const corrected = enforceContrast(border, bg, { minRatio: 1.5 });
    expect(contrastRatio(hex(corrected), hex(bg))).toBeGreaterThanOrEqual(1.5);
  });

  test("ensureSurfaceDistinct nudges identical surface/bg", () => {
    const bg = "#0B0B12";
    const fixed = ensureSurfaceDistinct(bg, bg);
    expect(fixed).not.toBe(bg);
    // The nudge should be small — not radically different.
    const dist = contrastRatio(hex(fixed), hex(bg));
    expect(dist).toBeGreaterThan(1);
    expect(dist).toBeLessThan(2);
  });

  test("parses 3-char, 6-char, and 8-char hex", () => {
    expect(parseHex("#F00")).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseHex("#FF0000")).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseHex("#FF0000AA")).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseHex("nope")).toBeNull();
  });
});
