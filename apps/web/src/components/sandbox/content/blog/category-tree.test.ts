import { describe, expect, it } from "bun:test";
import type { BlogEntry } from "./blog-data";
import {
  categoryAncestors,
  categoryPathSegments,
  descendantSlugs,
  MAX_CATEGORY_DEPTH,
  orderCategoryTree,
} from "./category-tree";

function cat(slug: string, parentSlug?: string, label = slug): BlogEntry {
  return {
    key: `collections/blog/categories/${slug}`,
    kind: "categories",
    label,
    subtitle: slug,
    slug,
    parentSlug,
    missing: [],
  };
}

/** `slug@depth` per row — the shape of the rendered list. */
function layout(entries: BlogEntry[]): string[] {
  return orderCategoryTree(entries).map((r) => `${r.entry.slug}@${r.depth}`);
}

describe("orderCategoryTree", () => {
  it("nests children under their parent, siblings alphabetical", () => {
    expect(
      layout([
        cat("desserts", "recipes"),
        cat("recipes"),
        cat("news"),
        cat("cakes", "desserts"),
        cat("bread", "recipes"),
      ]),
    ).toEqual(["news@0", "recipes@0", "bread@1", "desserts@1", "cakes@2"]);
  });

  it("treats a dangling parentSlug as a root", () => {
    expect(layout([cat("orphan", "gone"), cat("root")])).toEqual([
      "orphan@0",
      "root@0",
    ]);
  });

  it("treats a self-reference as a root", () => {
    expect(layout([cat("loop", "loop")])).toEqual(["loop@0"]);
  });

  it("emits every member of a cycle exactly once", () => {
    // No root, so the fallback pass opens the cycle at the first entry.
    expect(layout([cat("a", "b"), cat("b", "a")])).toEqual(["a@0", "b@1"]);
  });

  it("flattens a chain deeper than the cap instead of dropping it", () => {
    const chain = ["a", "b", "c", "d", "e"].map((slug, i, all) =>
      cat(slug, i === 0 ? undefined : all[i - 1]),
    );
    const rows = orderCategoryTree(chain);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3, 0]);
    expect(Math.max(...rows.map((r) => r.depth))).toBeLessThan(
      MAX_CATEGORY_DEPTH,
    );
  });

  it("keeps a duplicated slug visible, both at root", () => {
    expect(
      layout([cat("dup", undefined, "A"), cat("dup", "dup", "B")]),
    ).toEqual(["dup@0", "dup@0"]);
  });

  it("never nests an entry with no slug of its own", () => {
    const nameless: BlogEntry = {
      key: "collections/blog/categories/x",
      kind: "categories",
      label: "Unnamed",
      subtitle: "",
      parentSlug: "recipes",
      missing: ["slug"],
    };
    const rows = orderCategoryTree([cat("recipes"), nameless]);
    expect(rows.find((r) => r.entry === nameless)?.depth).toBe(0);
  });

  it("keeps an entry with no slug at all", () => {
    const nameless: BlogEntry = {
      key: "collections/blog/categories/x",
      kind: "categories",
      label: "Unnamed category",
      subtitle: "",
      missing: ["name", "slug"],
    };
    expect(orderCategoryTree([nameless])).toEqual([
      { entry: nameless, depth: 0 },
    ]);
  });

  it("returns nothing for no entries", () => {
    expect(orderCategoryTree([])).toEqual([]);
  });
});

describe("categoryAncestors", () => {
  const tree = [
    cat("recipes"),
    cat("desserts", "recipes"),
    cat("cakes", "desserts"),
  ];

  it("returns the chain root first, the category last", () => {
    expect(categoryAncestors("cakes", tree).map((c) => c.slug)).toEqual([
      "recipes",
      "desserts",
      "cakes",
    ]);
  });

  it("returns just the category for a root", () => {
    expect(categoryAncestors("recipes", tree).map((c) => c.slug)).toEqual([
      "recipes",
    ]);
  });

  it("returns nothing for an unknown slug", () => {
    expect(categoryAncestors("ghost", tree)).toEqual([]);
  });

  it("truncates a cycle instead of looping", () => {
    const cyclic = [cat("a", "b"), cat("b", "a")];
    expect(categoryAncestors("a", cyclic).map((c) => c.slug)).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("descendantSlugs", () => {
  const tree = [
    cat("recipes"),
    cat("desserts", "recipes"),
    cat("cakes", "desserts"),
    cat("news"),
  ];

  it("collects the whole subtree, excluding the root itself", () => {
    expect([...descendantSlugs("recipes", tree)].sort()).toEqual([
      "cakes",
      "desserts",
    ]);
  });

  it("is empty for a leaf", () => {
    expect([...descendantSlugs("cakes", tree)]).toEqual([]);
  });

  it("terminates on a cycle without listing the start again", () => {
    expect([...descendantSlugs("a", [cat("a", "b"), cat("b", "a")])]).toEqual([
      "b",
    ]);
  });
});

describe("categoryPathSegments", () => {
  const tree = [
    cat("recipes"),
    cat("desserts", "recipes"),
    cat("cakes", "desserts"),
  ];

  it("returns the whole chain, root first", () => {
    expect(categoryPathSegments("cakes", tree)).toEqual([
      "recipes",
      "desserts",
      "cakes",
    ]);
  });

  it("returns nothing for an empty slug", () => {
    expect(categoryPathSegments("", tree)).toEqual([]);
  });

  it("returns the bare slug for an unknown one", () => {
    expect(categoryPathSegments("ghost", tree)).toEqual(["ghost"]);
  });

  it("collapses a cycle to the bare slug, where the layout puts it", () => {
    expect(categoryPathSegments("a", [cat("a", "b"), cat("b", "a")])).toEqual([
      "a",
    ]);
  });

  it("collapses a chain past the cap, where the layout puts it", () => {
    const chain = ["a", "b", "c", "d", "e"].map((slug, i, all) =>
      cat(slug, i === 0 ? undefined : all[i - 1]),
    );
    expect(categoryPathSegments("d", chain)).toEqual(["a", "b", "c", "d"]);
    expect(categoryPathSegments("e", chain)).toEqual(["e"]);
  });
});

describe("duplicated slugs", () => {
  it("nests a child under the parent that actually resolved it", () => {
    // Two "dup" categories; only the first is addressable, so the child
    // belongs under it and must not follow the other one.
    const first = cat("dup", undefined, "A dup");
    const second = cat("dup", undefined, "B dup");
    const child = cat("child", "dup");
    const rows = orderCategoryTree([first, second, child]);
    const order = rows.map((r) => `${r.entry.label}@${r.depth}`);
    expect(order).toEqual(["A dup@0", "child@1", "B dup@0"]);
  });
});
