import { describe, expect, it } from "bun:test";
import {
  buildFileTree,
  decoBlockKeyFromTreePath,
  directoryNeedsLazyLoad,
  EXPLORER_EAGER_DEPTH,
  flattenTree,
  getDirectoryContextPath,
  getParentTreePath,
  getPathDepth,
  joinTreePath,
  mergeGlobLists,
  pathExistsInFileList,
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
    expect(validateExplorerEntryName(".env")).toMatch(
      /cannot start with a dot/,
    );
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

  it("directoryNeedsLazyLoad is true at EXPLORER_EAGER_DEPTH and above", () => {
    const loaded = new Set(["/apps/mesh/src"]);
    expect(directoryNeedsLazyLoad("/apps", loaded)).toBe(false);
    expect(directoryNeedsLazyLoad("/apps/mesh/src", loaded)).toBe(false);
    expect(directoryNeedsLazyLoad("/apps/mesh/deep", loaded)).toBe(true);
    expect(getPathDepth("/apps/mesh/deep")).toBeGreaterThanOrEqual(
      EXPLORER_EAGER_DEPTH,
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
      truncated: undefined,
    });
  });
});
