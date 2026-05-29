import { describe, expect, it } from "bun:test";
import { BANNER_GRADIENT, BANNER_LINES, bannerLines } from "./banner-art";

describe("banner-art", () => {
  it("has one gradient color per art line", () => {
    expect(BANNER_LINES.length).toBe(8);
    expect(BANNER_GRADIENT.length).toBe(BANNER_LINES.length);
  });

  it("renders the art with no version line when version is omitted", () => {
    const lines = bannerLines();
    expect(lines.length).toBe(BANNER_LINES.length);
    // Truecolor escape prefix on every art line.
    expect(lines.every((l) => l.startsWith("\x1b[38;2;"))).toBe(true);
  });

  it("appends a dimmed version line when a version is given", () => {
    const lines = bannerLines("1.2.3");
    expect(lines.length).toBe(BANNER_LINES.length + 1);
    expect(lines.at(-1)).toContain("1.2.3");
  });
});
