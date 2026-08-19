import { describe, expect, it } from "bun:test";
import { BLOCK_PATH_RE, mergeBlocks } from "./merge";

describe("mergeBlocks", () => {
  it("merges files into a flat key -> content document", () => {
    const { decofile, skipped } = mergeBlocks([
      { stem: "b", content: '{"n":2}' },
      { stem: "a", content: '{"n":1}' },
    ]);
    expect(decofile).toBe('{"a":{"n":1},"b":{"n":2}}');
    expect(skipped).toEqual([]);
  });

  it("preserves pretty-printed content verbatim", () => {
    const pretty = '{\n  "n": 1\n}';
    const { decofile } = mergeBlocks([{ stem: "a", content: pretty }]);
    expect(decofile).toBe(`{"a":${pretty}}`);
    expect(JSON.parse(decofile)).toEqual({ a: { n: 1 } });
  });

  it("single-decodes a single-encoded stem (space in the key)", () => {
    const { decofile } = mergeBlocks([
      { stem: "Compre%20Junto", content: '{"v":"single"}' },
    ]);
    expect(decofile).toBe('{"Compre Junto":{"v":"single"}}');
  });

  it("single-decodes a double-encoded stem to its %20 key, not a space", () => {
    // Decoding the key's own `%20` to a space would dangle the runtime reference.
    const { decofile } = mergeBlocks([
      { stem: "Compre%2520Junto", content: '{"v":"double"}' },
    ]);
    expect(decofile).toBe('{"Compre%20Junto":{"v":"double"}}');
  });

  it("keys a %20-bearing page the way the deco runtime resolves it", () => {
    // "Home Page" is keyed `pages-Home%20Page-<id>`, stored `…%2520….json`.
    const page = { __resolveType: "website/pages/Page.tsx" };
    const { decofile } = mergeBlocks([
      { stem: "pages-Home%2520Page-40404", content: JSON.stringify(page) },
    ]);
    expect(JSON.parse(decofile)).toEqual({ "pages-Home%20Page-40404": page });
  });

  it("skips empty and whitespace-only files", () => {
    const { decofile } = mergeBlocks([
      { stem: "empty", content: "" },
      { stem: "spaces", content: "  \n\t" },
      { stem: "a", content: "{}" },
    ]);
    expect(decofile).toBe('{"a":{}}');
  });

  it("sorts by filename, not stem (matches the Go daemon byte-for-byte)", () => {
    // "a-b.json" < "a.json" ("-" sorts before "."), while stem "a" < "a-b".
    const { decofile } = mergeBlocks([
      { stem: "a", content: "1" },
      { stem: "a-b", content: "2" },
    ]);
    expect(decofile).toBe('{"a-b":2,"a":1}');
  });

  it("returns an empty document for no files", () => {
    expect(mergeBlocks([])).toEqual({ decofile: "{}", skipped: [] });
  });

  it("drops a block that is not valid JSON and keeps the document parseable", () => {
    // A raw `.tsx` source spliced in would make the whole document unparseable.
    const { decofile, skipped } = mergeBlocks([
      { stem: "good", content: '{"ok":true}' },
      { stem: "broken", content: "import { H } from './x'" },
    ]);
    expect(JSON.parse(decofile)).toEqual({ good: { ok: true } });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ key: "broken", stem: "broken" });
    expect(skipped[0]?.error).toBeTruthy();
  });

  it("drops a broken block between valid ones without breaking the commas", () => {
    const { decofile, skipped } = mergeBlocks([
      { stem: "a", content: '{"n":1}' },
      { stem: "b", content: "oops not json" },
      { stem: "c", content: '{"n":3}' },
    ]);
    expect(JSON.parse(decofile)).toEqual({ a: { n: 1 }, c: { n: 3 } });
    expect(skipped.map((s) => s.key)).toEqual(["b"]);
  });

  it("reports every skipped block in filename order", () => {
    const { decofile, skipped } = mergeBlocks([
      { stem: "a", content: "nope" },
      { stem: "b", content: '{"ok":true}' },
      { stem: "c", content: "also nope" },
    ]);
    expect(JSON.parse(decofile)).toEqual({ b: { ok: true } });
    expect(skipped).toHaveLength(2);
    expect(skipped.map((s) => s.key)).toEqual(["a", "c"]);
  });

  it("reports the decoded key for a skipped block with an encoded stem", () => {
    const { decofile, skipped } = mergeBlocks([
      { stem: "Compre%20Junto", content: "not json" },
    ]);
    expect(decofile).toBe("{}");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      key: "Compre Junto",
      stem: "Compre%20Junto",
    });
  });

  it("drops a later file whose decoded key collides with an earlier one", () => {
    // Both stems decode to the same key — splicing both would emit a duplicate JSON key.
    const { decofile, skipped } = mergeBlocks([
      { stem: "Compre Junto", content: '{"v":"literal"}' },
      { stem: "Compre%20Junto", content: '{"v":"encoded"}' },
    ]);
    expect(JSON.parse(decofile)).toEqual({ "Compre Junto": { v: "literal" } });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      key: "Compre Junto",
      stem: "Compre%20Junto",
    });
  });
});

describe("BLOCK_PATH_RE", () => {
  it("matches block paths at root and under a package path", () => {
    expect(BLOCK_PATH_RE.test(".deco/blocks/a.json")).toBe(true);
    expect(BLOCK_PATH_RE.test("apps/site/.deco/blocks/a.json")).toBe(true);
    expect(BLOCK_PATH_RE.test(".deco/blocks/a.JSON")).toBe(true);
  });

  it("rejects non-block paths", () => {
    expect(BLOCK_PATH_RE.test(".deco/blocks.gen.json")).toBe(false);
    expect(BLOCK_PATH_RE.test(".deco/tools/a.json")).toBe(false);
    expect(BLOCK_PATH_RE.test("deco/blocks/a.json")).toBe(false);
  });
});
