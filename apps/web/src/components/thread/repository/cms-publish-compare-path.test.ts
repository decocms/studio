import { describe, expect, test } from "bun:test";
import {
  canRenderCompare,
  compareDraftUrl,
  comparePageUrl,
  compareSectionUrl,
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
