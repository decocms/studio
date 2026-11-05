import { describe, expect, it } from "bun:test";
import { blockMeta, indexEntry } from "./block-meta";
import vectors from "./block-meta-vectors.json";

describe("blockMeta (the shared vectors)", () => {
  for (const c of vectors.cases) {
    it(`${c.name}: meta, version and entry`, () => {
      expect(blockMeta(c.body, vectors.names)).toEqual(c.meta);
      expect(indexEntry(c.name, c.body, vectors.names)).toEqual(
        c.entry as never,
      );
      expect(indexEntry(c.name, c.body, vectors.names).version).toBe(c.version);
    });
  }

  it("a body that yields nothing gives {} and an entry without meta", () => {
    expect(blockMeta(null, ["a"])).toEqual({});
    expect(blockMeta([{ __resolveType: "a" }], ["a"])).toEqual({});
    expect(blockMeta("a", ["a"])).toEqual({});
    expect(indexEntry("x", { t: 1 }, [])).not.toHaveProperty("meta");
  });

  it("refs are deduped, code-unit sorted and limited to names", () => {
    const body = {
      a: [{ __resolveType: "b" }, { __resolveType: "B" }],
      c: { d: { __resolveType: "b" } },
      e: { __resolveType: "z" },
    };
    expect(blockMeta(body, new Set(["b", "B"]))).toEqual({ refs: ["B", "b"] });
  });

  it("keeps an empty path, and only the CMS entry inlines its body", () => {
    expect(blockMeta({ path: "" }, [])).toEqual({ path: "" });
    expect(indexEntry("CMS", { a: 1 }, [])).toHaveProperty("data", { a: 1 });
    expect(indexEntry("cms", { a: 1 }, [])).not.toHaveProperty("data");
  });
});
