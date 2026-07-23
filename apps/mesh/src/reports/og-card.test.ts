import { describe, expect, test } from "bun:test";
import { renderOgCard } from "./og-card";

/** PNG magic bytes — a valid render always starts with these. */
function isPng(bytes: Uint8Array): boolean {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e;
}

// Pure render (no faviconUrl ⇒ no network): satori + resvg + embedded fonts.
describe("renderOgCard", () => {
  test.each([
    ["typical score", { domain: "nike.com", initial: "N", score: 47 }],
    ["score 0", { domain: "example.com", initial: "E", score: 0 }],
    ["score 100", { domain: "shop.io", initial: "S", score: 100 }],
    ["fractional score rounds", { domain: "a.com", initial: "A", score: 68.7 }],
    // Regression: a long domain must NOT squish the fixed-size favicon/initial
    // tile to zero width (flexShrink: 0). Here it just must render, not crash.
    [
      "long domain wraps without crashing",
      {
        domain: "very-long-subdomain.enterprise-commerce-store.co.uk",
        initial: "V",
        score: 42,
      },
    ],
  ])("renders a valid PNG: %s", async (_label, input) => {
    const png = await renderOgCard(input);
    expect(isPng(png)).toBe(true);
    expect(png.length).toBeGreaterThan(1000);
  });
});
