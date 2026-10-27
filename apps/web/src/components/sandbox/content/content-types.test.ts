import { describe, expect, test } from "bun:test";
import type { Change } from "@decocms/blocks/protocol";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import {
  aliasTarget,
  buildContentTypes,
  entryName,
  entryStatus,
  FOLD_KEEP,
  foldSameDestination,
  humanizeTypeKey,
  inRedirectPathGroup,
  manifestGroupOf,
  pageSectionCount,
  redirectDestinationPage,
  redirectPathGroups,
  routeMatches,
  summaryFieldsOf,
  typeOfBlock,
  typeTitle,
  TOP_TYPES,
  visibleTypes,
} from "./content-types";

const ref = (key: string) => ({
  $ref: `#/definitions/${btoa(key)}`,
  namespace: "site",
});
const def = (title: string) => ({ title, type: "object" });

/** A v8 schema shaped like `deco schema`'s, trimmed to what this needs. */
const meta = {
  blocksMajor: 8,
  aliases: {
    "website/pages/Page.tsx": "page",
    "website/loaders/redirect.ts": "redirect",
  },
  manifest: {
    blocks: {
      pages: {
        page: { ...ref("page"), namespace: "deco" },
        "website/pages/Page.tsx": ref("website/pages/Page.tsx"),
      },
      redirects: {
        redirect: { ...ref("redirect"), namespace: "deco" },
        "website/loaders/redirect.ts": ref("website/loaders/redirect.ts"),
      },
      sections: {
        "site-header": ref("site-header"),
        "site-footer": ref("site-footer"),
        "product-shelf": ref("product-shelf"),
        "site/sections/Promo/PromoBar.tsx": ref(
          "site/sections/Promo/PromoBar.tsx",
        ),
        banner: ref("banner"),
        hero: ref("hero"),
        newsletter: ref("newsletter"),
        carousel: ref("carousel"),
      },
      loaders: {
        "shopify-product-list": ref("shopify-product-list"),
        "shopify-product-details-page": ref("shopify-product-details-page"),
        "product-by-handle": ref("product-by-handle"),
        "vtex/loaders/search.ts": {
          ...ref("vtex/loaders/search.ts"),
          namespace: "vtex",
        },
      },
      matchers: { device: ref("device") },
      content: {
        "cms-settings": { ...ref("cms-settings"), namespace: "deco" },
        "split-traffic": { ...ref("split-traffic"), namespace: "deco" },
      },
    },
  },
  schema: {
    definitions: {
      [btoa("page")]: def("page"),
      [btoa("redirect")]: def("redirect"),
      [btoa("cms-settings")]: def("cms-settings"),
      [btoa("site-header")]: def("Header"),
      [btoa("site-footer")]: def("Footer"),
      [btoa("product-shelf")]: def("Product Shelf"),
      [btoa("site/sections/Promo/PromoBar.tsx")]: def(
        "site/sections/Promo/PromoBar.tsx",
      ),
      [btoa("shopify-product-list")]: def("Shopify Product List"),
      [btoa("shopify-product-details-page")]: def(
        "Shopify Product Details Page",
      ),
      [btoa("product-by-handle")]: def("Product by Handle"),
      [btoa("vtex/loaders/search.ts")]: def("Search"),
      [btoa("device")]: def("Device"),
    },
  },
} as unknown as LiveMeta;

const set = (baseVersion: string | null): Change => ({
  kind: "set",
  version: "v2",
  baseVersion,
});
const del: Change = { kind: "delete", version: null, baseVersion: "v1" };

describe("type names", () => {
  test("built-ins get Studio's names", () => {
    expect(typeTitle(meta, "page")).toBe("Pages");
    expect(typeTitle(meta, "redirect")).toBe("Redirects");
    expect(typeTitle(meta, "cms-settings")).toBe("Settings");
  });
  test("an alias is named as its target", () => {
    expect(typeTitle(meta, "website/pages/Page.tsx")).toBe("Pages");
  });
  test("the schema's title, else the key humanized", () => {
    expect(typeTitle(meta, "site-header")).toBe("Header");
    expect(typeTitle(meta, "site/sections/Promo/PromoBar.tsx")).toBe(
      "Promo Bar",
    );
    expect(typeTitle(meta, "unknown-thing")).toBe("Unknown Thing");
    expect(humanizeTypeKey("site/sections/Product/ProductShelf.tsx")).toBe(
      "Product Shelf",
    );
  });
});

describe("manifest groups and aliases", () => {
  test("an alias folds into its target's group", () => {
    expect(aliasTarget(meta, "website/loaders/redirect.ts")).toBe("redirect");
    expect(manifestGroupOf(meta, "website/loaders/redirect.ts")).toBe(
      "redirects",
    );
    expect(manifestGroupOf(meta, "device")).toBe("matchers");
    expect(manifestGroupOf(meta, "nope")).toBeNull();
  });
  test("a block typed as a saved block is filed under that block's type", () => {
    const blocks = { Header: { __resolveType: "site-header" } };
    expect(typeOfBlock(meta, blocks, { __resolveType: "Header" })).toBe(
      "site-header",
    );
  });
});

describe("status per entry", () => {
  test("from the draft's change", () => {
    expect(entryStatus(undefined)).toBe("published");
    expect(entryStatus(set("v1"))).toBe("changed");
    expect(entryStatus(set(null))).toBe("new");
    expect(entryStatus(del)).toBe("deleted");
  });
});

describe("buildContentTypes", () => {
  const blocks = {
    "pages-home": {
      __resolveType: "page",
      name: "Home",
      path: "/",
      sections: [{ __resolveType: "Header" }, { __resolveType: "hero" }],
    },
    "pages-legacy": {
      __resolveType: "website/pages/Page.tsx",
      name: "Legacy",
      path: "/legacy",
      sections: [],
    },
    "redirect-a": {
      __resolveType: "website/loaders/redirect.ts",
      from: "/a",
      to: "/",
    },
    Header: { __resolveType: "site-header", logo: "x" },
    Footer: { __resolveType: "site-footer" },
    CMS: { __resolveType: "cms-settings" },
    "Shelf 1": { __resolveType: "product-shelf", title: "Best sellers" },
    "Shelf 2": { __resolveType: "product-shelf", title: "New in" },
    Pinned: { __resolveType: "product-by-handle" },
    "PDP Loader": { __resolveType: "shopify-product-details-page" },
    "List Loader": { __resolveType: "shopify-product-list" },
    Search: { __resolveType: "vtex/loaders/search.ts" },
    Desktop: { __resolveType: "device", desktop: true },
    Mobile: { __resolveType: "device", mobile: true },
    experiments: { __resolveType: "split-traffic" },
  };
  const tree = buildContentTypes({
    blocks,
    meta,
    changes: {
      "pages-home": set("v1"),
      "Shelf 2": set(null),
      "pages-gone": del,
    },
    deleted: {
      "pages-gone": { __resolveType: "page", name: "Gone", path: "/gone" },
    },
  });

  test("only types with saved blocks, aliases folded into one type", () => {
    // The home page first, what the draft deletes last.
    expect(tree.pages?.entries.map((e) => e.key)).toEqual([
      "pages-home",
      "pages-legacy",
      "pages-gone",
    ]);
    expect(tree.redirects?.entries.length).toBe(1);
    expect(tree.all.some((t) => t.id === "banner")).toBe(false);
  });
  test("collections: Pages and Redirects first, then 2+ entries, most first", () => {
    // Redirects holds one entry and is still a collection. No manifest
    // groups and no apps: a rule is a type like any other.
    expect(tree.collections.map((t) => [t.title, t.entries.length])).toEqual([
      ["Pages", 3],
      ["Redirects", 1],
      ["Device", 2],
      ["Product Shelf", 2],
    ]);
  });
  test("singletons: every type with one entry, by name", () => {
    // Loaders too: one entry opens directly, whatever its manifest group.
    expect(tree.singletons.map((t) => t.title)).toEqual([
      "Footer",
      "Header",
      "Product by Handle",
      "Search",
      "Settings",
      "Shopify Product Details Page",
      "Shopify Product List",
    ]);
    expect(tree.singletons.some((t) => t.id === "page")).toBe(false);
    expect(tree.singletons.some((t) => t.id === "redirect")).toBe(false);
    for (const type of tree.singletons) expect(type.entries.length).toBe(1);
  });
  test("Pages and Redirects are collections even with one entry", () => {
    const one = buildContentTypes({
      blocks: {
        home: { __resolveType: "page", name: "Home", path: "/" },
        r: { __resolveType: "redirect", from: "/a", to: "/" },
        Header: { __resolveType: "site-header" },
      },
      meta,
      changes: {},
    });
    expect(one.collections.map((t) => t.id)).toEqual(["page", "redirect"]);
    expect(one.singletons.map((t) => t.id)).toEqual(["site-header"]);
  });
  test("a type grows from singleton to collection at two entries", () => {
    const of = (n: number) =>
      buildContentTypes({
        blocks: Object.fromEntries(
          Array.from({ length: n }, (_, i) => [
            `Shelf ${i}`,
            { __resolveType: "product-shelf" },
          ]),
        ),
        meta,
        changes: {},
      });
    expect(of(1).singletons.map((t) => t.id)).toEqual(["product-shelf"]);
    expect(of(1).collections).toEqual([]);
    expect(of(2).collections.map((t) => t.id)).toEqual(["product-shelf"]);
    expect(of(2).singletons).toEqual([]);
  });
  test("a deleted singleton keeps its row, its one entry deleted", () => {
    const gone = buildContentTypes({
      blocks: {},
      meta,
      changes: { Footer: del },
      deleted: { Footer: { __resolveType: "site-footer" } },
    });
    expect(gone.singletons.map((t) => t.id)).toEqual(["site-footer"]);
    expect(gone.singletons[0]?.entries.map((e) => e.status)).toEqual([
      "deleted",
    ]);
    expect(gone.singletons[0]?.changed).toBe(1);
  });
  test("no named rules (they keep their own views)", () => {
    expect(tree.all.some((t) => t.id === "split-traffic")).toBe(false);
    expect(tree.collections.some((t) => t.id === "split-traffic")).toBe(false);
    expect(tree.singletons.some((t) => t.id === "split-traffic")).toBe(false);
  });
  test("statuses, deletions included, and the draft's changes", () => {
    const status = Object.fromEntries(
      tree.pages!.entries.map((e) => [e.key, e.status]),
    );
    expect(status).toEqual({
      "pages-gone": "deleted",
      "pages-home": "changed",
      "pages-legacy": "published",
    });
    expect(tree.pages?.changed).toBe(2);
    expect(tree.changed.map((c) => c.entry.key).sort()).toEqual([
      "Shelf 2",
      "pages-gone",
      "pages-home",
    ]);
  });
  test("new entries first, then by name (a redirect's by its source)", () => {
    const t = buildContentTypes({
      blocks: {
        r1: { __resolveType: "redirect", from: "/b", to: "/" },
        r2: { __resolveType: "redirect", from: "/a", to: "/" },
        r3: { __resolveType: "redirect", from: "/z", to: "/" },
      },
      meta,
      changes: { r3: set(null) },
    });
    expect(t.redirects?.entries.map((e) => e.key)).toEqual(["r3", "r2", "r1"]);
  });
  test("a deletion without its published copy is left out of the types", () => {
    const t = buildContentTypes({ blocks: {}, meta, changes: { x: del } });
    expect(t.all).toEqual([]);
  });
  test("the draft's changes are its whole list, typed or not", () => {
    const t = buildContentTypes({
      blocks: {
        experiments: { __resolveType: "split-traffic" },
        loose: { untyped: true },
        "pages-home": { __resolveType: "page", name: "Home", path: "/" },
      },
      meta,
      changes: {
        experiments: set("v1"),
        loose: set(null),
        "pages-home": set("v1"),
        // Deleted, its published copy not read (yet).
        gone: del,
      },
    });
    expect(
      t.changed.map((c) => [c.type.title, c.entry.key, c.entry.status]),
    ).toEqual([
      ["Pages", "pages-home", "changed"],
      ["Split Traffic", "experiments", "changed"],
      ["", "gone", "deleted"],
      ["", "loose", "new"],
    ]);
    // Named rules still keep their own views.
    expect(t.all.some((x) => x.id === "split-traffic")).toBe(false);
    expect(t.changed.find((c) => c.entry.key === "gone")?.entry.orphan).toBe(
      true,
    );
    expect(t.changed.find((c) => c.entry.key === "loose")?.entry.orphan).toBe(
      undefined,
    );
  });
  test("until the changes are read, no status is known", () => {
    const t = buildContentTypes({ blocks, meta, changes: undefined });
    expect(t.statusKnown).toBe(false);
    expect(t.changed).toEqual([]);
    expect(tree.statusKnown).toBe(true);
  });
});

describe("redirect filters and folding", () => {
  const r = (
    from: string,
    to: string,
    status: "published" | "new" = "published",
  ) => ({
    key: from,
    block: { __resolveType: "redirect", from, to },
    status,
  });
  test("folders two or more sources share, then the rest", () => {
    const list = [
      r("/products/a", "/"),
      r("/products/b", "/"),
      r("/collections/x", "/"),
      r("/collections/y", "/"),
      r("/men", "/"),
      r("/blog/one", "/"),
    ];
    const groups = redirectPathGroups(list);
    expect(groups).toEqual([
      { segment: "collections", count: 2 },
      { segment: "products", count: 2 },
      { segment: "", count: 2 },
    ]);
    expect(
      list.filter((e) => inRedirectPathGroup(e, "", groups)).map((e) => e.key),
    ).toEqual(["/men", "/blog/one"]);
    // One part only: no filters.
    expect(redirectPathGroups(list.slice(0, 2))).toEqual([]);
  });
  test("many redirects to one page fold, changes never do", () => {
    const list = [
      r("/new", "/c", "new"),
      ...Array.from({ length: 30 }, (_, i) => r(`/p${i}`, "/c")),
      r("/other", "/d"),
    ];
    const { shown, folded } = foldSameDestination(list);
    expect(folded).toBe(30 - FOLD_KEEP);
    expect(shown.map((e) => e.key)).toContain("/new");
    expect(shown.map((e) => e.key)).toContain("/other");
    expect(foldSameDestination(list.slice(0, 8)).folded).toBe(0);
  });
});

describe("sidebar sizing", () => {
  const type = (id: string, n: number) => ({
    id,
    group: "sections" as const,
    title: id,
    entries: Array.from({ length: n }, (_, i) => ({
      key: `${id}${i}`,
      block: {},
      status: "published" as const,
    })),
    changed: 0,
  });
  test("top eight collections, then Show all", () => {
    const many = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((n, i) =>
      type(`t${i}`, n),
    );
    const top = visibleTypes(many, false);
    expect(TOP_TYPES).toBe(8);
    expect(top.shown.length).toBe(TOP_TYPES);
    expect(top.hidden).toBe(2);
    expect(visibleTypes(many, true).shown.length).toBe(10);
    expect(visibleTypes(many.slice(0, 8), false).hidden).toBe(0);
  });
  test("Pages and Redirects lead the top eight; Show all counts every collection", () => {
    const blocks: Record<string, unknown> = {
      home: { __resolveType: "page", name: "Home", path: "/" },
      r: { __resolveType: "redirect", from: "/a", to: "/" },
    };
    for (let i = 0; i < 9; i++) {
      for (let j = 0; j < 2 + i; j++) {
        blocks[`kind-${i}-${j}`] = { __resolveType: `kind-${i}` };
      }
    }
    const built = buildContentTypes({ blocks, meta, changes: {} });
    expect(built.collections.length).toBe(11);
    const top = visibleTypes(built.collections, false);
    expect(top.shown.map((t) => t.id).slice(0, 3)).toEqual([
      "page",
      "redirect",
      "kind-8",
    ]);
    expect(top.shown.length).toBe(TOP_TYPES);
    expect(top.hidden).toBe(3);
  });
  test("the open type shows even past the top eight", () => {
    const many = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((n, i) =>
      type(`t${i}`, n),
    );
    const open = visibleTypes(many, false, "t9");
    expect(open.shown.map((t) => t.id)).toEqual([
      "t0",
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
      "t6",
      "t7",
      "t9",
    ]);
    expect(open.hidden).toBe(1);
    // One already in the top eight adds nothing.
    expect(visibleTypes(many, false, "t2").shown.length).toBe(TOP_TYPES);
    expect(visibleTypes(many, false, "nope").hidden).toBe(2);
  });
});

describe("table columns", () => {
  const page = (key: string, path: string) => ({
    key,
    block: { __resolveType: "page", path, sections: [{}, {}] },
    status: "published" as const,
  });
  test("a redirect's destination page: exact path, then a route", () => {
    const pages = [
      page("home", "/"),
      page("collection", "/collections/:handle"),
      page("notfound", "/*"),
    ];
    expect(redirectDestinationPage(pages, "/")?.key).toBe("home");
    expect(redirectDestinationPage(pages, "/collections/sol")?.key).toBe(
      "collection",
    );
    expect(redirectDestinationPage(pages, "/x/y")?.key).toBe("notfound");
    expect(redirectDestinationPage(pages, "https://x.com/")).toBeNull();
    expect(routeMatches("/collections/:handle", "/collections")).toBe(false);
  });
  test("an entry's name: its name, a redirect's source, else its key", () => {
    const e = (block: Record<string, unknown>) => ({
      key: "PDP%20Loader",
      block,
      status: "published" as const,
    });
    expect(entryName(e({ name: "Home" }))).toBe("Home");
    expect(entryName(e({ redirect: { from: "/a", to: "/" } }))).toBe("/a");
    expect(entryName(e({}))).toBe("PDP Loader");
  });
  test("a page's section count", () => {
    expect(pageSectionCount(page("p", "/"))).toBe(2);
  });
  test("one or two fields the entries hold as text", () => {
    const shelf = buildContentTypes({
      blocks: {
        a: { __resolveType: "product-shelf", title: "A", headline: "" },
        b: { __resolveType: "product-shelf", title: "B" },
      },
      meta,
      changes: {},
    }).collections[0]!;
    expect(summaryFieldsOf(shelf)).toEqual(["title"]);
  });
});
