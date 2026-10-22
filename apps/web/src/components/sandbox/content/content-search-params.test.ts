import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  contentSearchParams,
  variantFocusFromSearch,
} from "./content-search-params";

const schema = z.object(contentSearchParams);

describe("the place to open in the content editor", () => {
  it("reads the page variant, section and variant", () => {
    const search = schema.parse({
      contentPageId: "pages-home-1",
      contentPageVariant: 1,
      contentSection: 2,
      contentVariant: 0,
    });
    expect(variantFocusFromSearch(search)).toEqual({
      pageVariant: 1,
      section: 2,
      variant: 0,
    });
  });

  it("is none without a place", () => {
    expect(
      variantFocusFromSearch(schema.parse({ contentPageId: "pages-home-1" })),
    ).toBeNull();
  });

  it("drops a value that isn't a place instead of failing the page", () => {
    const search = schema.parse({
      contentPageId: "pages-home-1",
      contentSection: -1,
      contentVariant: "x",
      contentPageVariant: 1.5,
    });
    expect(search.contentPageId).toBe("pages-home-1");
    expect(variantFocusFromSearch(search)).toBeNull();
  });
});
