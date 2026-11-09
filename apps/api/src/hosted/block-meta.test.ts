import { describe, expect, it } from "bun:test";
import {
  blockMeta,
  INLINE_BLOCK,
  indexEntry,
  META_VERSION,
  pageNoIndex,
  seoNoIndex,
} from "./block-meta";
import vectors from "./block-meta-vectors.json";

describe("blockMeta (the shared vectors)", () => {
  // A page's saved SEO block is looked up among the cases.
  const bodyOf = (name: string) =>
    vectors.cases.find((c) => c.name === name)?.body;
  for (const c of vectors.cases) {
    it(`${c.name}: meta, version and entry`, async () => {
      expect(blockMeta(c.body, vectors.names, bodyOf)).toEqual(c.meta);
      const entry = await indexEntry(c.name, c.body, vectors.names, bodyOf);
      expect(entry).toEqual(c.entry as never);
      expect(entry.version).toBe(c.version);
    });
  }

  it("a body that yields nothing gives {} and an entry without meta", async () => {
    expect(blockMeta(null, ["a"])).toEqual({});
    expect(blockMeta([{ __resolveType: "a" }], ["a"])).toEqual({});
    expect(blockMeta("a", ["a"])).toEqual({});
    expect(await indexEntry("x", { t: 1 }, [])).not.toHaveProperty("meta");
  });

  it("refs are deduped, code-unit sorted and limited to names", () => {
    const body = {
      a: [{ __resolveType: "b" }, { __resolveType: "B" }],
      c: { d: { __resolveType: "b" } },
      e: { __resolveType: "z" },
    };
    expect(blockMeta(body, new Set(["b", "B"]))).toEqual({ refs: ["B", "b"] });
  });

  it("keeps an empty path, and only the CMS entry inlines its body", async () => {
    expect(blockMeta({ path: "" }, [])).toEqual({ path: "" });
    expect(INLINE_BLOCK).toBe("CMS");
    expect(await indexEntry("CMS", { a: 1 }, [])).toHaveProperty("data", {
      a: 1,
    });
    expect(await indexEntry("cms", { a: 1 }, [])).not.toHaveProperty("data");
  });
});

describe("noIndex (meta version 2)", () => {
  it("is meta version 2", () => {
    expect(META_VERSION).toBe(2);
  });

  it("a saved SEO block counts only when bodyOf knows it", () => {
    const page = {
      __resolveType: "page",
      path: "/p",
      seo: { __resolveType: "DefaultSeo" },
    };
    const bodyOf = (n: string) =>
      n === "DefaultSeo" ? { noIndexing: true } : undefined;
    expect(blockMeta(page, ["DefaultSeo"]).noIndex).toBeUndefined();
    expect(blockMeta(page, ["DefaultSeo"], bodyOf).noIndex).toBe(true);
    expect(blockMeta({ ...page, path: undefined }, [], bodyOf)).toEqual({
      type: "page",
    });
  });

  it("only a page (a top-level string path) is noIndex", () => {
    expect(pageNoIndex({ path: "/p", seo: { noIndexing: true } })).toBe(true);
    expect(pageNoIndex({ seo: { noIndexing: true } })).toBe(false);
  });

  it("stops at a cycle", () => {
    const bodyOf = (n: string) => ({ __resolveType: n === "a" ? "b" : "a" });
    expect(seoNoIndex({ __resolveType: "a" }, bodyOf)).toBe(false);
  });
});
