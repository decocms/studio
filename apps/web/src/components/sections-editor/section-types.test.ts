import { describe, expect, test } from "bun:test";
import { labelFromResolveType } from "./section-types";

describe("labelFromResolveType", () => {
  test("humanizes a TypeScript section path", () => {
    expect(labelFromResolveType("site/sections/Product/ProductShelf.tsx")).toBe(
      "ProductShelf",
    );
    expect(labelFromResolveType("site/sections/hero-banner.tsx")).toBe(
      "Hero Banner",
    );
  });

  test("drops the extension of template-based sections", () => {
    expect(labelFromResolveType("vendor/sections/banners_carousel.html")).toBe(
      "Banners Carousel",
    );
    expect(labelFromResolveType("vendor/sections/spot.htm")).toBe("Spot");
  });

  test("keeps a block id without an extension", () => {
    expect(labelFromResolveType("footer-links")).toBe("Footer Links");
  });
});
