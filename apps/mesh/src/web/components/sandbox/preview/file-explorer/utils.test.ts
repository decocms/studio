import { describe, expect, it } from "bun:test";
import {
  buildFileTree,
  buildGrepHighlight,
  decoBlockKeyFromTreePath,
  directoryNeedsLazyLoad,
  flattenTree,
  getDirectoryContextPath,
  getParentTreePath,
  getPathDepth,
  groupGrepMatches,
  isSafeExplorerOpenPath,
  joinTreePath,
  matchFileNames,
  mergeGlobLists,
  parseGrepContent,
  pathExistsInFileList,
  stripLineNumbers,
  toDaemonPath,
  toTreePath,
  validateExplorerEntryName,
} from "./utils";

describe("file-explorer utils", () => {
  it("joinTreePath joins under parent", () => {
    expect(joinTreePath("/src", "index.ts")).toBe("/src/index.ts");
    expect(joinTreePath("/", "README.md")).toBe("/README.md");
  });

  it("getDirectoryContextPath uses directory path for folders", () => {
    expect(getDirectoryContextPath("/src", "directory")).toBe("/src");
    expect(getDirectoryContextPath("/src/index.ts", "file")).toBe("/src");
  });

  it("validateExplorerEntryName rejects unsafe names", () => {
    expect(validateExplorerEntryName("ok.ts")).toBeNull();
    expect(validateExplorerEntryName("../evil")).toMatch(/cannot contain/);
    expect(validateExplorerEntryName("a/b")).toMatch(/cannot contain/);
    expect(validateExplorerEntryName(".env")).toBeNull();
    expect(validateExplorerEntryName("")).toMatch(/required/i);
  });

  it("pathExistsInFileList detects files and directories", () => {
    const files = ["src/index.ts", "src/utils.ts", "README.md"];
    const directories = ["empty-dir"];
    expect(pathExistsInFileList("/src/index.ts", files, directories)).toBe(
      true,
    );
    expect(pathExistsInFileList("/src", files, directories)).toBe(true);
    expect(pathExistsInFileList("/empty-dir", files, directories)).toBe(true);
    expect(pathExistsInFileList("/missing", files, directories)).toBe(false);
  });

  it("buildFileTree includes empty directories", () => {
    const tree = buildFileTree([], ["tavano-folder"]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.name).toBe("tavano-folder");
    expect(tree[0]?.kind).toBe("directory");
    const rows = flattenTree(tree, new Set());
    expect(rows.some((row) => row.node.name === "tavano-folder")).toBe(true);
  });

  it("decoBlockKeyFromTreePath decodes block keys", () => {
    expect(decoBlockKeyFromTreePath("/.deco/blocks/Header.json")).toBe(
      "Header",
    );
    expect(decoBlockKeyFromTreePath("/.deco/blocks/hello%20world.json")).toBe(
      "hello world",
    );
    expect(decoBlockKeyFromTreePath("/src/index.ts")).toBeNull();
  });

  it("toDaemonPath strips leading slash", () => {
    expect(toDaemonPath("/src/index.ts")).toBe("src/index.ts");
    expect(getParentTreePath("/src/index.ts")).toBe("/src");
  });

  it("toTreePath adds leading slash", () => {
    expect(toTreePath("src/index.ts")).toBe("/src/index.ts");
    expect(toTreePath("/src/index.ts")).toBe("/src/index.ts");
    expect(toTreePath("")).toBe("/");
  });

  it("getPathDepth counts tree path segments", () => {
    expect(getPathDepth("/")).toBe(0);
    expect(getPathDepth("/apps")).toBe(1);
    expect(getPathDepth("/apps/mesh/src")).toBe(3);
    expect(getPathDepth("/apps/mesh/src/index.ts")).toBe(4);
  });

  it("directoryNeedsLazyLoad is true only below eager depth boundary", () => {
    const loaded = new Set(["/apps/mesh/src"]);
    expect(directoryNeedsLazyLoad("/apps", loaded)).toBe(false);
    expect(directoryNeedsLazyLoad("/apps/mesh/src", loaded)).toBe(false);
    expect(directoryNeedsLazyLoad("/apps/mesh/src/components", loaded)).toBe(
      true,
    );
  });

  it("mergeGlobLists unions files and directories", () => {
    expect(
      mergeGlobLists(["a.ts"], ["src"], {
        files: ["b.ts"],
        directories: ["src/components"],
      }),
    ).toEqual({
      files: ["a.ts", "b.ts"],
      directories: ["src", "src/components"],
      truncated: false,
    });
  });

  it("isSafeExplorerOpenPath rejects traversal, double-leading-slash, backslash, and remote paths", () => {
    expect(isSafeExplorerOpenPath("../../etc/passwd")).toBe(false);
    expect(isSafeExplorerOpenPath("src/../../etc/passwd")).toBe(false);
    // Double leading slash survives the single-slash strip in toDaemonPath,
    // so it's still absolute-looking and must be rejected.
    expect(isSafeExplorerOpenPath("//etc/passwd")).toBe(false);
    expect(isSafeExplorerOpenPath("..\\..\\windows\\win.ini")).toBe(false);
    expect(isSafeExplorerOpenPath("https://evil.com/steal")).toBe(false);
    expect(isSafeExplorerOpenPath("")).toBe(false);
  });

  it("isSafeExplorerOpenPath allows workspace-relative tree paths and .deco block refs", () => {
    // Tree paths carry a single leading slash by convention (see toTreePath);
    // toDaemonPath strips it back to a workspace-relative daemon path.
    expect(isSafeExplorerOpenPath("src/index.ts")).toBe(true);
    expect(isSafeExplorerOpenPath("/src/index.ts")).toBe(true);
    expect(isSafeExplorerOpenPath(".deco/blocks/Header.json")).toBe(true);
  });

  it("mergeGlobLists preserves truncated across merges", () => {
    expect(
      mergeGlobLists(
        ["a.ts"],
        ["src"],
        { files: [], directories: [], truncated: true },
        true,
      ),
    ).toEqual({
      files: ["a.ts"],
      directories: ["src"],
      truncated: true,
    });
  });

  it("parseGrepContent maps repo-relative rows to tree paths", () => {
    const matches = parseGrepContent(
      'src/index.ts:12:const x = 1;\n.deco/blocks/Header.json:3:  "title": "hi"',
    );
    expect(matches).toEqual([
      { path: "/src/index.ts", line: 12, text: "const x = 1;" },
      { path: "/.deco/blocks/Header.json", line: 3, text: '  "title": "hi"' },
    ]);
  });

  it("parseGrepContent keeps colons in the matched text", () => {
    const [match] = parseGrepContent("a.ts:7:const url = 'http://x';");
    expect(match).toEqual({
      path: "/a.ts",
      line: 7,
      text: "const url = 'http://x';",
    });
  });

  it("parseGrepContent skips rows without a valid file:line prefix", () => {
    expect(parseGrepContent("")).toEqual([]);
    // ripgrep context separators / malformed rows are dropped
    expect(parseGrepContent("--\nnot-a-match\nfile.ts:nope:text")).toEqual([]);
  });

  it("matchFileNames finds deep files by leaf name, regardless of tree depth", () => {
    const files = [
      "src/index.ts",
      ".deco/blocks/analytics.json",
      ".deco/blocks/pages/home.json",
      "README.md",
    ];
    // The whole point of the fix: a deep, unexpanded file still matches.
    expect(matchFileNames(files, "analytics.json", 50)).toEqual([
      "/.deco/blocks/analytics.json",
    ]);
    // Case-insensitive, leaf-name substring.
    expect(matchFileNames(files, "JSON", 50)).toEqual([
      "/.deco/blocks/analytics.json",
      "/.deco/blocks/pages/home.json",
    ]);
  });

  it("matchFileNames matches on the leaf name, not the directory path", () => {
    const files = ["blocks/index.ts", "src/util.ts"];
    // "blocks" is a directory segment, not part of any leaf name → no match.
    expect(matchFileNames(files, "blocks", 50)).toEqual([]);
    expect(matchFileNames(files, "index", 50)).toEqual(["/blocks/index.ts"]);
  });

  it("matchFileNames caps results and treats blank queries as no-op", () => {
    const files = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
    expect(matchFileNames(files, ".ts", 3)).toHaveLength(3);
    expect(matchFileNames(files, "   ", 3)).toEqual([]);
  });

  it("buildGrepHighlight highlights every case-insensitive occurrence", () => {
    const hl = buildGrepHighlight("  const Foo = foo(bar);", "foo");
    expect(hl.leadingEllipsis).toBe(false);
    // Leading whitespace trimmed; both "Foo" and "foo" highlighted.
    expect(hl.segments).toEqual([
      { text: "const ", match: false },
      { text: "Foo", match: true },
      { text: " = ", match: false },
      { text: "foo", match: true },
      { text: "(bar);", match: false },
    ]);
    expect(hl.segments.map((s) => s.text).join("")).toBe(
      "const Foo = foo(bar);",
    );
  });

  it("buildGrepHighlight clips a long prefix so the match stays visible", () => {
    const line = `${"x".repeat(60)}NEEDLE tail`;
    const hl = buildGrepHighlight(line, "needle");
    expect(hl.leadingEllipsis).toBe(true);
    // Prefix trimmed to ~24 context chars before the match.
    const firstMatch = hl.segments.find((s) => s.match);
    expect(firstMatch).toEqual({ text: "NEEDLE", match: true });
    expect(hl.segments[0]?.text.length).toBeLessThanOrEqual(24);
  });

  it("buildGrepHighlight highlights every occurrence after clipping a long prefix", () => {
    const line = `${"x".repeat(60)}NEEDLE bar NEEDLE tail`;
    const hl = buildGrepHighlight(line, "needle");
    expect(hl.leadingEllipsis).toBe(true);
    const matchCount = hl.segments.filter((s) => s.match).length;
    expect(matchCount).toBe(2);
    // Reconstructing the (clipped) segments must reproduce the clipped tail
    // exactly — no characters dropped or duplicated by the clip + scan logic.
    const reconstructed = hl.segments.map((s) => s.text).join("");
    expect(line.endsWith(reconstructed)).toBe(true);
  });

  it("buildGrepHighlight has no ellipsis exactly at the clip boundary", () => {
    // First match starts right at GREP_HIGHLIGHT_PREFIX (24 context chars) —
    // the `first > 24` check must not clip on the boundary itself.
    const line = `${"x".repeat(24)}NEEDLE`;
    const hl = buildGrepHighlight(line, "needle");
    expect(hl.leadingEllipsis).toBe(false);
  });

  it("buildGrepHighlight matches back-to-back overlapping-alphabet runs without dropping chars", () => {
    const hl = buildGrepHighlight("aaaa", "aa");
    expect(hl.segments).toEqual([
      { text: "aa", match: true },
      { text: "aa", match: true },
    ]);
  });

  it("buildGrepHighlight returns a single plain run when nothing matches", () => {
    expect(buildGrepHighlight("  no hits here", "zzz")).toEqual({
      leadingEllipsis: false,
      segments: [{ text: "no hits here", match: false }],
    });
    expect(buildGrepHighlight("anything", "  ")).toEqual({
      leadingEllipsis: false,
      segments: [{ text: "anything", match: false }],
    });
  });

  it("groupGrepMatches groups by file preserving first-seen order", () => {
    const groups = groupGrepMatches([
      { path: "/b.ts", line: 1, text: "a" },
      { path: "/a.ts", line: 2, text: "b" },
      { path: "/b.ts", line: 5, text: "c" },
    ]);
    expect(groups).toEqual([
      {
        path: "/b.ts",
        matches: [
          { path: "/b.ts", line: 1, text: "a" },
          { path: "/b.ts", line: 5, text: "c" },
        ],
      },
      { path: "/a.ts", matches: [{ path: "/a.ts", line: 2, text: "b" }] },
    ]);
  });
});

describe("stripLineNumbers", () => {
  it("strips the <n>\\t prefix from a single line", () => {
    expect(stripLineNumbers("1\thello")).toBe("hello");
  });

  it("strips the prefix from every line", () => {
    expect(stripLineNumbers('1\t{\n2\t  "a": 1\n3\t}')).toBe('{\n  "a": 1\n}');
  });

  it("preserves a line containing a carriage return verbatim", () => {
    // A `(.*)` capture would stop at \r and truncate the rest; `replace` keeps it.
    expect(stripLineNumbers("1\tvalue\rmore")).toBe("value\rmore");
  });

  it("preserves U+2028 / U+2029 line separators (the regression this fixes)", () => {
    // These aren't `\n`, so `.split("\n")` keeps them within one line; the old
    // `(.*)` capture stopped at them and truncated the tail. `replace` keeps it.
    expect(stripLineNumbers("1\ta b")).toBe("a b");
    expect(stripLineNumbers("1\tx y")).toBe("x y");
  });

  it("leaves a line without a numeric-tab prefix untouched", () => {
    expect(stripLineNumbers("no prefix here")).toBe("no prefix here");
    // Only a leading <digits>\t is stripped, not an interior tab.
    expect(stripLineNumbers("1\tkey\tvalue")).toBe("key\tvalue");
  });
});
