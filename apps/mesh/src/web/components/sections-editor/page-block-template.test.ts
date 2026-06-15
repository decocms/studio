import { describe, expect, it } from "bun:test";
import {
  createEmptyPageBlock,
  DEFAULT_PAGE_BLOCK,
  generatePageBlockKey,
} from "./page-block-template";

describe("page-block-template", () => {
  it("createEmptyPageBlock uses default resolve types", () => {
    expect(createEmptyPageBlock("About", "/about")).toEqual({
      name: "About",
      path: "/about",
      sections: [],
      seo: { __resolveType: DEFAULT_PAGE_BLOCK.seoResolveType },
      __resolveType: DEFAULT_PAGE_BLOCK.resolveType,
    });
  });

  it("generatePageBlockKey uses the page name in the block id", () => {
    expect(generatePageBlockKey("My Page")).toMatch(
      /^pages-My Page-[0-9a-f-]{36}$/,
    );
  });
});
