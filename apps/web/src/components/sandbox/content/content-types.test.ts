import { describe, expect, test } from "bun:test";
import type { Change } from "@decocms/blocks/protocol";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import {
  aliasTarget,
  appGroupCollapsedByDefault,
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
  visibleSectionTypes,
  TOP_SECTION_TYPES,
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
  test("singletons of sections and content are Everywhere", () => {
    expect(tree.everywhere.map((t) => t.title)).toEqual([
      "Footer",
      "Header",
      "Settings",
    ]);
    expect(tree.sections.map((t) => t.title)).toEqual(["Product Shelf"]);
  });
  test("loaders under their app; the site's own by vendor word", () => {
    expect(
      tree.apps.map((a) => [a.label, a.types.map((t) => t.title)]),
    ).toEqual([
      ["Shopify", ["Product Details Page", "Product List"]],
      ["Vtex", ["Search"]],
      // The site's own data loaders, last ("Site data").
      ["", ["Product by Handle"]],
    ]);
  });
  test("rules, and no named rules (they keep their own views)", () => {
    expect(tree.rules.map((t) => [t.title, t.entries.length])).toEqual([
      ["Device", 2],
    ]);
    expect(tree.all.some((t) => t.id === "split-traffic")).toBe(false);
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
  test("top five section types, then Show all", () => {
    const many = [9, 8, 7, 6, 5, 4, 3].map((n, i) => type(`t${i}`, n));
    const top = visibleSectionTypes(many, false);
    expect(top.shown.length).toBe(TOP_SECTION_TYPES);
    expect(top.hidden).toBe(2);
    expect(visibleSectionTypes(many, true).shown.length).toBe(7);
    expect(visibleSectionTypes(many.slice(0, 3), false).hidden).toBe(0);
  });
  test("an app with many types starts collapsed", () => {
    const four = [1, 2, 3, 4].map((n) => type(`a${n}`, 1));
    expect(appGroupCollapsedByDefault({ label: "A", types: four })).toBe(true);
    expect(
      appGroupCollapsedByDefault({ label: "A", types: four.slice(0, 2) }),
    ).toBe(false);
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
    }).sections[0]!;
    expect(summaryFieldsOf(shelf)).toEqual(["title"]);
  });
});
