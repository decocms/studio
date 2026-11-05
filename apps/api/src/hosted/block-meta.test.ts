import { describe, expect, it } from "bun:test";
import { blockMeta, INLINE_BLOCK, indexEntry } from "./block-meta";
import vectors from "./block-meta-vectors.json";

describe("blockMeta (the shared vectors)", () => {
  for (const c of vectors.cases) {
    it(`${c.name}: meta, version and entry`, async () => {
      expect(blockMeta(c.body, vectors.names)).toEqual(c.meta);
      const entry = await indexEntry(c.name, c.body, vectors.names);
      expect(entry).toEqual(c.entry as never);
      expect(entry.version).toBe(c.version);
    });
  }

  it("the vectors pin meta.rules: a test and campaign uses, and a saved rule", () => {
    const byName = new Map(vectors.cases.map((c) => [c.name, c]));
    expect(byName.get("ab-test")?.meta).toMatchObject({
      rules: ["", "Natal", "black-friday", "buy-button"],
    });
    expect(byName.get("summer-rule")?.meta).toEqual({
      type: "campaign",
      rules: ["summer"],
    });
  });

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

  it("rules: every experiment/campaign name at any depth, deduped and code-unit sorted, whatever the index's names", () => {
    const body = {
      __resolveType: "multivariate",
      variants: [
        { rule: { __resolveType: "campaign", name: "b" }, value: 1 },
        {
          rule: {
            __resolveType: "multi",
            matchers: [
              { __resolveType: "experiment", name: "B" },
              { __resolveType: "campaign", name: "b" },
            ],
          },
          value: { __resolveType: "lazy", value: { x: 1 } },
        },
        { rule: { __resolveType: "never" }, value: 2 },
      ],
    };
    expect(blockMeta(body, [])).toEqual({
      type: "multivariate",
      rules: ["B", "b"],
    });
  });

  it("not rules: a non-string name, an inline date, the whole map, multivariate's experiment field", () => {
    const body = {
      __resolveType: "multivariate",
      experiment: "hero",
      variants: [
        { rule: { __resolveType: "experiment", name: 3 } },
        { rule: { __resolveType: "date", start: "2026-01-01" } },
        { value: { __resolveType: "experiments" } },
      ],
    };
    expect(blockMeta(body, ["experiments"])).toEqual({
      type: "multivariate",
      refs: ["experiments"],
    });
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
