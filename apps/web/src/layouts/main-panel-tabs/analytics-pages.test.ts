import { describe, expect, it } from "bun:test";
import {
  groupPathsByPage,
  readPathAudience,
  sortPageAudience,
} from "./analytics-pages";

const pages = [
  { key: "pages-home", name: "Home", path: "/" },
  { key: "pages-search", name: "Search", path: "/s" },
  { key: "pages-pdp", name: "Product", path: "/:slug/p" },
  { key: "pages-blog", name: "Blog post", path: "/blog/:slug/" },
  { key: "pages-lp", name: "Landing", path: "/bf{/70-off}?" },
  { key: "pages-about", name: "About", path: "/about" },
];

const rows = (...list: [string, number | string, (number | string)?][]) =>
  readPathAudience({
    pageAudience: list.map(([k, n, pv]) => ({ k, n, pv })),
  });

const visitorsOf = (paths: ReturnType<typeof rows>, list = pages) =>
  Object.fromEntries(
    groupPathsByPage(list, paths)
      .pages.filter((p) => p.visitors > 0)
      .map((p) => [p.page.key, p.visitors]),
  );

describe("readPathAudience", () => {
  it("merges trailing-slash twins and drops malformed rows", () => {
    expect(rows(["/a", 3, 5], ["/a/", "2", "4"], ["/b", "x"])).toEqual([
      { path: "/a", visitors: 5, pageviews: 9 },
    ]);
  });

  it("takes pageviews from a `pages` panel when rows carry none", () => {
    expect(
      readPathAudience({
        pageAudience: [{ k: "/", n: 10 }],
        pages: [{ k: "/", n: "25" }],
      }),
    ).toEqual([{ path: "/", visitors: 10, pageviews: 25 }]);
  });

  it("reads nothing from a payload without the panel", () => {
    expect(readPathAudience(undefined)).toEqual([]);
    expect(readPathAudience({ registered: false })).toEqual([]);
  });
});

describe("groupPathsByPage", () => {
  it("gives a static page its exact path", () => {
    expect(visitorsOf(rows(["/", 100], ["/s/", "40"]))).toEqual({
      "pages-home": 100,
      "pages-search": 40,
    });
  });

  it("sums a template's URLs, most visitors first", () => {
    const { pages: out } = groupPathsByPage(
      pages,
      rows(["/tenis-b/p", 20, 30], ["/tenis-a/p", 30, 45]),
    );
    const pdp = out.find((p) => p.page.key === "pages-pdp");
    expect(pdp).toMatchObject({ template: true, visitors: 50, pageviews: 75 });
    expect(pdp?.urls.map((u) => u.path)).toEqual(["/tenis-a/p", "/tenis-b/p"]);
  });

  it("prefers the most specific template over a catch-all", () => {
    const withCatchAll = [
      ...pages,
      { key: "pages-plp", name: "Category", path: "/*" },
    ];
    expect(
      visitorsOf(rows(["/x/p", 3], ["/masculino/tenis", 15]), withCatchAll),
    ).toEqual({ "pages-pdp": 3, "pages-plp": 15 });
  });

  it("matches optional segments both ways", () => {
    expect(visitorsOf(rows(["/bf", 3], ["/bf/70-off", 4]))).toEqual({
      "pages-lp": 7,
    });
  });

  it("lists paths no page serves as other routes", () => {
    const out = groupPathsByPage(pages, rows(["/checkout", 9], ["/", 1]));
    expect(out.other.map((r) => r.path)).toEqual(["/checkout"]);
  });

  it("keeps every page, and pageviews unknown when none were sent", () => {
    const out = groupPathsByPage(pages, rows(["/", 1]));
    expect(out.pages).toHaveLength(pages.length);
    expect(out.hasPageviews).toBe(false);
    expect(out.pages[0]?.pageviews).toBeUndefined();
  });

  it("does not treat regex characters in a path as patterns", () => {
    const dotted = [{ key: "pages-a", name: "A", path: "/a.b/:id" }];
    expect(groupPathsByPage(dotted, rows(["/axb/1", 1])).other).toHaveLength(1);
  });
});

describe("sortPageAudience", () => {
  const out = groupPathsByPage(
    pages,
    rows(["/x/p", 10, 90], ["/", 50, 60]),
  ).pages;

  it("orders by visitors, then name for pages without traffic", () => {
    expect(
      sortPageAudience(out, "visitors", -1).map((p) => p.page.name),
    ).toEqual(["Home", "Product", "About", "Blog post", "Landing", "Search"]);
  });

  it("orders by pageviews and by name", () => {
    expect(
      sortPageAudience(out, "pageviews", -1)
        .slice(0, 2)
        .map((p) => p.page.name),
    ).toEqual(["Product", "Home"]);
    expect(sortPageAudience(out, "name", 1)[0]?.page.name).toBe("About");
  });
});
