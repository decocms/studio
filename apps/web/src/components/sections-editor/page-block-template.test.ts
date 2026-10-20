import { describe, expect, it } from "bun:test";
import {
  createEmptyPageBlock,
  DEFAULT_PAGE_BLOCK,
  generatePageBlockKey,
} from "./page-block-template";
import type { LiveMeta } from "./resolve-schema";

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

  it("keeps the v7 page and SEO types for a v7 schema", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          pages: { "website/pages/Page.tsx": { $ref: "#/definitions/Page" } },
          sections: {
            "website/sections/Seo/SeoV2.tsx": { $ref: "#/definitions/S" },
          },
        },
      },
      schema: { definitions: { Page: { type: "object" }, S: {} } },
    };
    expect(createEmptyPageBlock("About", "/about", meta)).toEqual(
      createEmptyPageBlock("About", "/about"),
    );
  });

  it("generatePageBlockKey encodes the page name with a unique suffix", () => {
    expect(generatePageBlockKey("My Page")).toMatch(
      /^pages-My%20Page-[0-9a-f-]{36}$/,
    );
  });
});
