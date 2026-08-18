import { describe, expect, it } from "bun:test";
import type { TreeEntry } from "./github-git-data";
import {
  aliasPathsForKey,
  blockEntriesInTree,
  blocksDirPath,
} from "./read-decofile";

function blob(path: string): TreeEntry {
  return { path, mode: "100644", type: "blob", sha: `sha-${path}` };
}

describe("blocksDirPath", () => {
  it("handles root and nested projects", () => {
    expect(blocksDirPath(null)).toBe(".deco/blocks");
    expect(blocksDirPath("apps/site")).toBe("apps/site/.deco/blocks");
  });
});

describe("blockEntriesInTree", () => {
  it("keeps only direct .json children of the blocks dir", () => {
    const tree: TreeEntry[] = [
      blob(".deco/blocks/Header.json"),
      blob(".deco/blocks/Upper.JSON"),
      blob(".deco/blocks/nested/deep.json"),
      blob(".deco/blocks/readme.md"),
      blob(".deco/blocks.gen.json"),
      blob("src/index.ts"),
      { path: ".deco/blocks", mode: "040000", type: "tree", sha: "t" },
    ];
    const stems = blockEntriesInTree(tree, null).map((e) => e.stem);
    expect(stems.sort()).toEqual(["Header", "Upper"]);
  });

  it("scopes to the package path", () => {
    const tree: TreeEntry[] = [
      blob(".deco/blocks/root.json"),
      blob("apps/site/.deco/blocks/nested.json"),
    ];
    expect(blockEntriesInTree(tree, "apps/site").map((e) => e.stem)).toEqual([
      "nested",
    ]);
    expect(blockEntriesInTree(tree, null).map((e) => e.stem)).toEqual(["root"]);
  });
});

describe("aliasPathsForKey", () => {
  it("finds every spelling that single-decodes to the key, sorted", () => {
    const entries = [
      // A single-decode: %2520 keeps its %20; %20 becomes a space — distinct keys.
      { stem: "Compre%2520Junto", path: ".deco/blocks/Compre%2520Junto.json" },
      { stem: "Compre%20Junto", path: ".deco/blocks/Compre%20Junto.json" },
      // Case-varied hex both decode to "A/B" — genuine twins.
      { stem: "A%2FB", path: ".deco/blocks/A%2FB.json" },
      { stem: "A%2fB", path: ".deco/blocks/A%2fB.json" },
    ];
    expect(aliasPathsForKey(entries, "Compre Junto")).toEqual([
      ".deco/blocks/Compre%20Junto.json",
    ]);
    expect(aliasPathsForKey(entries, "Compre%20Junto")).toEqual([
      ".deco/blocks/Compre%2520Junto.json",
    ]);
    expect(aliasPathsForKey(entries, "A/B")).toEqual([
      ".deco/blocks/A%2FB.json",
      ".deco/blocks/A%2fB.json",
    ]);
    expect(aliasPathsForKey(entries, "missing")).toEqual([]);
  });
});
