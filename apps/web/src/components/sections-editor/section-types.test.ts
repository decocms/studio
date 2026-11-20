import { describe, expect, test } from "bun:test";
import { capitalizeWords, labelFromResolveType } from "./section-types";

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

  test("an accented letter does not split the word", () => {
    expect(labelFromResolveType("benefícios-app")).toBe("Benefícios App");
  });
});

describe("capitalizeWords", () => {
  test("an accented letter is part of the word, not a boundary", () => {
    expect(capitalizeWords("benefícios app versão att")).toBe(
      "Benefícios App Versão Att",
    );
    expect(capitalizeWords("água de coco")).toBe("Água De Coco");
  });

  test("a decomposed accent (NFD) does not split the word either", () => {
    expect(capitalizeWords("benefi\u0301cios")).toBe("Benefi\u0301cios");
  });

  test("ASCII reads as it did with \\b\\w", () => {
    expect(capitalizeWords("header a1b2c3")).toBe("Header A1b2c3");
    expect(capitalizeWords("d'agua")).toBe("D'Agua");
  });
});
