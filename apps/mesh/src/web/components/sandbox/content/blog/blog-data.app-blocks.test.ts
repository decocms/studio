import { describe, expect, test } from "bun:test";
import { isBlogAppBlockResolveType } from "./blog-data.ts";

describe("isBlogAppBlockResolveType", () => {
  test("matches deco-cms/blog app blocks", () => {
    expect(
      isBlogAppBlockResolveType("blog/sections/blocks/ProductCard.tsx"),
    ).toBe(true);
    expect(
      isBlogAppBlockResolveType("blog/sections/blocks/ProductShelf.tsx"),
    ).toBe(true);
  });

  test("does not match site-defined blog sections", () => {
    expect(
      isBlogAppBlockResolveType("site/sections/Blog/Post/ProductShelf.tsx"),
    ).toBe(false);
  });
});
