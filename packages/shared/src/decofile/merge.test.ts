import { describe, expect, it } from "bun:test";
import { BLOCK_PATH_RE, mergeBlocks } from "./merge";

describe("mergeBlocks", () => {
  it("merges files into a flat key -> content document", () => {
    const out = mergeBlocks([
      { stem: "b", content: '{"n":2}' },
      { stem: "a", content: '{"n":1}' },
    ]);
    expect(out).toBe('{"a":{"n":1},"b":{"n":2}}');
  });

  it("preserves pretty-printed content verbatim", () => {
    const pretty = '{\n  "n": 1\n}';
    const out = mergeBlocks([{ stem: "a", content: pretty }]);
    expect(out).toBe(`{"a":${pretty}}`);
    expect(JSON.parse(out)).toEqual({ a: { n: 1 } });
  });

  it("decodes double-encoded stems to a single key", () => {
    const out = mergeBlocks([
      { stem: "Compre%2520Junto", content: '{"v":"double"}' },
    ]);
    expect(JSON.parse(out)).toEqual({ "Compre Junto": { v: "double" } });
  });

  it("skips empty and whitespace-only files", () => {
    const out = mergeBlocks([
      { stem: "empty", content: "" },
      { stem: "spaces", content: "  \n\t" },
      { stem: "a", content: "{}" },
    ]);
    expect(out).toBe('{"a":{}}');
  });

  it("sorts by filename, not stem (matches the Go daemon byte-for-byte)", () => {
    // "a-b.json" < "a.json" ("-" sorts before "."), while stem "a" < "a-b".
    const out = mergeBlocks([
      { stem: "a", content: "1" },
      { stem: "a-b", content: "2" },
    ]);
    expect(out).toBe('{"a-b":2,"a":1}');
  });

  it("returns an empty document for no files", () => {
    expect(mergeBlocks([])).toBe("{}");
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
