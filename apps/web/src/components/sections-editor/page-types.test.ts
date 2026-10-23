import { describe, expect, test } from "bun:test";
import {
  isLegacyPageResolveType,
  isPageResolveType,
  LEGACY_PAGE_RESOLVE_TYPES,
} from "./page-types";
import {
  DEFAULT_LIVE_PAGE_RESOLVE_TYPE,
  findLivePageResolveType,
} from "./section-catalog";

/** The v7 page names are declared once (page-types.ts) for every reader. */
describe("v7 page types", () => {
  test("the two v7 page names, Page.tsx first", () => {
    expect([...LEGACY_PAGE_RESOLVE_TYPES]).toEqual([
      "website/pages/Page.tsx",
      "$live/pages/LivePage.tsx",
    ]);
    expect(DEFAULT_LIVE_PAGE_RESOLVE_TYPE).toBe("website/pages/Page.tsx");
  });

  test("only the v7 names are legacy pages; a short `page` key is not", () => {
    expect(isLegacyPageResolveType("website/pages/Page.tsx")).toBe(true);
    expect(isLegacyPageResolveType("$live/pages/LivePage.tsx")).toBe(true);
    expect(isLegacyPageResolveType("page")).toBe(false);
    expect(isPageResolveType("$live/pages/LivePage.tsx")).toBe(true);
    expect(isPageResolveType("page")).toBe(false);
  });

  test("the section catalog finds the same v7 page names", () => {
    expect(
      findLivePageResolveType({
        manifest: { blocks: { pages: { "$live/pages/LivePage.tsx": {} } } },
      } as never),
    ).toBe("$live/pages/LivePage.tsx");
    expect(findLivePageResolveType({ manifest: { blocks: {} } } as never)).toBe(
      DEFAULT_LIVE_PAGE_RESOLVE_TYPE,
    );
  });
});
