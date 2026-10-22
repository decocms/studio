import { describe, expect, test } from "bun:test";
import {
  blockComparePath,
  canRenderCompare,
  compareDraftUrl,
  comparePageUrl,
  comparePlaceholder,
  compareSectionUrl,
  compareUrl,
  initialComparePath,
  isComparePathEditable,
  isolatedSectionKey,
} from "./cms-publish-compare-path.ts";

const SITE = "https://www.example.com";

describe("initialComparePath", () => {
  test("a static page renders its own path", () => {
    expect(initialComparePath({ kind: "page", pagePath: "/sale" }, null)).toBe(
      "/sale",
    );
  });

  test("global blocks and site settings render the home page", () => {
    expect(initialComparePath({ kind: "block", pagePath: null }, null)).toBe(
      "/",
    );
  });

  test("code changes start on the home page too", () => {
    expect(initialComparePath({ kind: "other", pagePath: null }, null)).toBe(
      "/",
    );
  });

  test("a page without a path asks for one", () => {
    expect(initialComparePath({ kind: "page", pagePath: null }, null)).toBe("");
    expect(initialComparePath({ kind: "page", pagePath: "" }, null)).toBe("");
  });

  test("a dynamic page reuses the last preview's values for the same template", () => {
    expect(
      initialComparePath(
        { kind: "page", pagePath: "/blog/:slug" },
        { path: "/blog/:slug", pageKey: null, params: { slug: "hello" } },
      ),
    ).toBe("/blog/hello");
  });

  test("a dynamic page asks for a path when the last preview was another page or incomplete", () => {
    expect(
      initialComparePath({ kind: "page", pagePath: "/blog/:slug" }, null),
    ).toBe("");
    expect(
      initialComparePath(
        { kind: "page", pagePath: "/blog/:slug" },
        { path: "/:slug/p", pageKey: null, params: { slug: "hello" } },
      ),
    ).toBe("");
    expect(
      initialComparePath(
        { kind: "page", pagePath: "/:category/:slug" },
        { path: "/:category/:slug", pageKey: null, params: { category: "a" } },
      ),
    ).toBe("");
  });
});

describe("comparePageUrl", () => {
  test("resolves a path against the live site", () => {
    expect(comparePageUrl(SITE, "/sale?x=1")?.toString()).toBe(
      `${SITE}/sale?x=1`,
    );
  });

  test("adds the leading slash and trims", () => {
    expect(comparePageUrl(SITE, "  sale ")?.toString()).toBe(`${SITE}/sale`);
  });

  test("never resolves off the live site's origin", () => {
    expect(comparePageUrl(SITE, "//elsewhere.example/x")).toBeNull();
    expect(comparePageUrl(SITE, "https://elsewhere.example/x")?.origin).toBe(
      SITE,
    );
  });

  test("empty or still-patterned paths are not renderable", () => {
    expect(comparePageUrl(SITE, "")).toBeNull();
    expect(comparePageUrl(SITE, "   ")).toBeNull();
    expect(comparePageUrl(SITE, "/blog/:slug")).toBeNull();
    expect(comparePageUrl(SITE, "/*")).toBeNull();
  });

  test("an unparsable site origin is not renderable", () => {
    expect(comparePageUrl("not a url", "/sale")).toBeNull();
  });
});

describe("isolatedSectionKey", () => {
  const block = {
    kind: "block" as const,
    blockKey: "Header Global",
    isSiteApp: false,
    fromJson: null,
    toJson: { __resolveType: "site/sections/Header/Header.tsx" },
  };

  test("a global section renders on its own", () => {
    expect(isolatedSectionKey(block)).toBe("Header Global");
  });

  test("a removed section still renders its published shape", () => {
    expect(
      isolatedSectionKey({
        ...block,
        fromJson: { __resolveType: "website/flags/multivariate/section.ts" },
        toJson: null,
      }),
    ).toBe("Header Global");
  });

  test("loaders, site settings and pages render inside a page", () => {
    expect(
      isolatedSectionKey({
        ...block,
        toJson: {
          __resolveType: "vtex/loaders/intelligentSearch/productList.ts",
        },
      }),
    ).toBeNull();
    expect(isolatedSectionKey({ ...block, isSiteApp: true })).toBeNull();
    expect(isolatedSectionKey({ ...block, kind: "page" })).toBeNull();
    expect(isolatedSectionKey({ ...block, toJson: {} })).toBeNull();
  });
});

describe("isComparePathEditable", () => {
  test("a static page is fixed to its own path", () => {
    expect(isComparePathEditable({ kind: "page", pagePath: "/sale" })).toBe(
      false,
    );
  });

  test("dynamic pages, pathless pages and blocks let the reviewer pick", () => {
    expect(
      isComparePathEditable({ kind: "page", pagePath: "/blog/:slug" }),
    ).toBe(true);
    expect(isComparePathEditable({ kind: "page", pagePath: null })).toBe(true);
    expect(isComparePathEditable({ kind: "block", pagePath: null })).toBe(true);
  });
});

describe("compareSectionUrl", () => {
  test("renders the block alone on the live site's preview route", () => {
    const url = compareSectionUrl(`${SITE}/any/path`, "Header Global");
    expect(url?.origin).toBe(SITE);
    expect(url?.pathname).toBe(
      `/live/previews/${encodeURIComponent("website/pages/Page.tsx")}`,
    );
    expect(url?.searchParams.has("__cb")).toBe(false);
    const props = JSON.parse(
      decodeURIComponent(atob(url?.searchParams.get("props") ?? "")),
    );
    expect(props.sections).toEqual([{ __resolveType: "Header Global" }]);
  });

  test("an unparsable site origin is not renderable", () => {
    expect(compareSectionUrl("not a url", "Header Global")).toBeNull();
  });
});

describe("compareDraftUrl", () => {
  const page = new URL(`${SITE}/sale?color=red`);

  test("no draft yet renders nothing", () => {
    expect(compareDraftUrl(page, null)).toBeNull();
  });

  test("Fast Preview keeps the live site and adds the draft pointer", () => {
    const url = new URL(
      compareDraftUrl(page, { kind: "pointer", pointer: "p1" }) ?? "",
    );
    expect(url.origin).toBe(SITE);
    expect(url.pathname).toBe("/sale");
    expect(url.searchParams.get("__draft")).toBe("p1");
  });

  test("a sandbox renders the same path and query on its dev server", () => {
    expect(
      compareDraftUrl(page, {
        kind: "sandbox",
        previewUrl: "https://sbx-1.preview.example.dev/",
      }),
    ).toBe("https://sbx-1.preview.example.dev/sale?color=red");
  });

  test("a global section preview keeps its props on the sandbox", () => {
    const section = compareSectionUrl(SITE, "Header");
    expect(section).not.toBeNull();
    const url = new URL(
      compareDraftUrl(section!, {
        kind: "sandbox",
        previewUrl: "https://sbx-1.preview.example.dev",
      }) ?? "",
    );
    expect(url.origin).toBe("https://sbx-1.preview.example.dev");
    expect(url.pathname).toBe(section!.pathname);
    expect(url.searchParams.get("props")).toBe(
      section!.searchParams.get("props"),
    );
  });
});

describe("canRenderCompare", () => {
  const sandbox = {
    kind: "sandbox",
    previewUrl: "https://sbx-1.preview.example.dev",
  } as const;
  const pointer = { kind: "pointer", pointer: "p1" } as const;

  test("content renders against the live site in either runtime", () => {
    expect(canRenderCompare("page", SITE, pointer)).toBe(true);
    expect(canRenderCompare("block", SITE, sandbox)).toBe(true);
    expect(canRenderCompare("block", SITE, null)).toBe(true);
  });

  test("code renders only on a sandbox, the one place it already runs", () => {
    expect(canRenderCompare("other", SITE, sandbox)).toBe(true);
    expect(canRenderCompare("other", SITE, pointer)).toBe(false);
    expect(canRenderCompare("other", SITE, null)).toBe(false);
  });

  test("nothing renders without a live site to compare against", () => {
    expect(canRenderCompare("page", null, pointer)).toBe(false);
    expect(canRenderCompare("other", null, sandbox)).toBe(false);
  });
});

const PAGE = "website/pages/Page.tsx";
/**
 * A v8 site's blocks: the Header is on every page, the Footer only on /about
 * and /men, the Promo only inside the Layout block /men uses, the Badge only
 * on the product page, and the Popup on no page.
 */
const BLOCKS: Record<string, unknown> = {
  Header: { __resolveType: "site/sections/Header/Header.tsx" },
  Footer: { __resolveType: "site/sections/Footer/Footer.tsx" },
  Promo: { __resolveType: "site/sections/Promo.tsx" },
  Badge: { __resolveType: "site/sections/Badge.tsx" },
  Popup: { __resolveType: "site/sections/Popup.tsx" },
  Layout: {
    __resolveType: "site/sections/Layout.tsx",
    children: [{ __resolveType: "Promo" }],
  },
  "pages-plp": {
    __resolveType: PAGE,
    path: "/*",
    sections: [{ __resolveType: "Header" }],
  },
  "pages-product": {
    __resolveType: PAGE,
    path: "/products/:slug",
    sections: [{ __resolveType: "Header" }, { __resolveType: "Badge" }],
  },
  "pages-men": {
    __resolveType: PAGE,
    path: "/men",
    sections: [
      { __resolveType: "Header" },
      { __resolveType: "Layout" },
      { __resolveType: "Footer" },
    ],
  },
  "pages-about": {
    __resolveType: PAGE,
    path: "/about",
    sections: [{ __resolveType: "Header" }, { __resolveType: "Footer" }],
  },
  "pages-home": {
    __resolveType: PAGE,
    path: "/",
    sections: [{ __resolveType: "Header" }],
  },
};

describe("blockComparePath (v8)", () => {
  test("a block on the home page compares there, even after previewing another page", () => {
    expect(blockComparePath("Header", BLOCKS, null)).toBe("/");
    expect(
      blockComparePath("Header", BLOCKS, {
        path: "/men",
        pageKey: "pages-men",
        params: {},
      }),
    ).toBe("/");
  });

  test("a block only on /about compares on /about", () => {
    const blocks = {
      Footer: BLOCKS.Footer,
      "pages-home": BLOCKS["pages-home"],
      "pages-about": BLOCKS["pages-about"],
    };
    expect(blockComparePath("Footer", blocks, null)).toBe("/about");
  });

  test("off the home page: the first static page by path, never a pattern first", () => {
    expect(blockComparePath("Footer", BLOCKS, null)).toBe("/about");
  });

  test("a block used through another saved block compares on that block's page", () => {
    expect(blockComparePath("Promo", BLOCKS, null)).toBe("/men");
  });

  test("a block only on a dynamic page: its pattern, filled from the last preview of it", () => {
    expect(blockComparePath("Badge", BLOCKS, null)).toBe("/products/:slug");
    expect(
      blockComparePath("Badge", BLOCKS, {
        path: "/products/:slug",
        pageKey: "pages-product",
        params: { slug: "shoe" },
      }),
    ).toBe("/products/shoe");
  });

  test("a block on no page has nothing to preview (code only), never the last page or /", () => {
    const last = { path: "/men", pageKey: "pages-men", params: {} };
    expect(blockComparePath("Popup", BLOCKS, last)).toBeNull();
    expect(blockComparePath("Popup", BLOCKS, null)).toBeNull();
    expect(blockComparePath("Missing", BLOCKS, null)).toBeNull();
  });

  test("undecided until the site's blocks are known", () => {
    expect(blockComparePath("Header", null, null)).toBeUndefined();
    expect(blockComparePath("Header", undefined, null)).toBeUndefined();
  });
});

describe("compareUrl", () => {
  test("v7: a saved section renders alone on /live/previews", () => {
    const url = compareUrl({
      previewServerUrl: SITE,
      sectionKey: "Header",
      path: "/",
      v8: false,
    });
    expect(url?.pathname.startsWith("/live/previews/")).toBe(true);
  });

  test("v8: a saved section renders on the page, never /live/previews", () => {
    const url = compareUrl({
      previewServerUrl: SITE,
      sectionKey: "Header",
      path: "/men",
      v8: true,
    });
    expect(url?.href).toBe(`${SITE}/men`);
  });

  test("a page change renders its path on v7 and v8 alike", () => {
    for (const v8 of [false, true]) {
      expect(
        compareUrl({
          previewServerUrl: SITE,
          sectionKey: null,
          path: "/sale",
          v8,
        })?.href,
      ).toBe(`${SITE}/sale`);
    }
  });
});

describe("comparePlaceholder", () => {
  test("a new page has no before, a removed page no after", () => {
    for (const v8 of [true, false]) {
      expect(comparePlaceholder({ kind: "page", status: "new" }, v8)).toEqual({
        before: "new",
        after: null,
      });
      expect(
        comparePlaceholder({ kind: "page", status: "removed" }, v8),
      ).toEqual({ before: null, after: "removed" });
    }
  });

  test("v8: a new or removed block renders the page on both sides", () => {
    for (const status of ["new", "removed", "edited"] as const) {
      expect(comparePlaceholder({ kind: "block", status }, true)).toEqual({
        before: null,
        after: null,
      });
    }
  });

  test("v7: a new or removed block shows the placeholder, as before", () => {
    expect(comparePlaceholder({ kind: "block", status: "new" }, false)).toEqual(
      { before: "new", after: null },
    );
    expect(
      comparePlaceholder({ kind: "block", status: "removed" }, false),
    ).toEqual({ before: null, after: "removed" });
    expect(
      comparePlaceholder({ kind: "block", status: "edited" }, false),
    ).toEqual({ before: null, after: null });
  });

  test("a new or removed code file renders the page on both sides", () => {
    for (const v8 of [true, false]) {
      for (const status of ["new", "removed"] as const) {
        expect(comparePlaceholder({ kind: "other", status }, v8)).toEqual({
          before: null,
          after: null,
        });
      }
    }
  });
});
