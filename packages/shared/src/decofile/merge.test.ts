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

  it("decodes double-encoded stems to a single key", () => {
    const { decofile } = mergeBlocks([
      { stem: "Compre%2520Junto", content: '{"v":"double"}' },
    ]);
    expect(JSON.parse(decofile)).toEqual({ "Compre Junto": { v: "double" } });
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
