import { describe, expect, test } from "bun:test";
import { blockSchemaTitle, labelFromResolveType } from "./section-types";

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

describe("blockSchemaTitle", () => {
  test("drops a title that is only the block's module path", () => {
    expect(
      blockSchemaTitle("site/sections/Content/DoubleCardImage.tsx"),
    ).toBeUndefined();
    expect(
      blockSchemaTitle("website/flags/multivariate/section.ts"),
    ).toBeUndefined();
    expect(blockSchemaTitle("vendor/sections/spot.html")).toBeUndefined();
  });

  test("keeps a human title, even one with a slash", () => {
    expect(blockSchemaTitle("Image Variants")).toBe("Image Variants");
    expect(blockSchemaTitle("Estampas / Flags")).toBe("Estampas / Flags");
    expect(blockSchemaTitle("Mensagem com imagem/GIF")).toBe(
      "Mensagem com imagem/GIF",
    );
    expect(blockSchemaTitle("Alerta/Tipbar")).toBe("Alerta/Tipbar");
  });

  test("keeps a short block key and an empty title", () => {
    expect(blockSchemaTitle("theme")).toBe("theme");
    expect(blockSchemaTitle("")).toBe("");
    expect(blockSchemaTitle(undefined)).toBeUndefined();
  });
});
