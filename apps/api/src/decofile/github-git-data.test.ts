import { describe, expect, it } from "bun:test";
import { resolveBlobsAtPaths, type TreeEntry } from "./github-git-data";

/** An in-memory repo tree, keyed by directory path ("" for root). */
function fakeOps(dirs: Record<string, TreeEntry[]>) {
  return {
    resolveSubtreeSha: (_root: string, segments: string[]) => {
      const dir = segments.join("/");
      return Promise.resolve(dir in dirs ? `tree:${dir}` : null);
    },
    treeShallow: (treeSha: string) => {
      const dir = treeSha.slice("tree:".length);
      return Promise.resolve(dirs[dir] ?? []);
    },
  };
}

const blob = (path: string, sha: string): TreeEntry => ({
  path,
  mode: "100644",
  type: "blob",
  sha,
});

describe("resolveBlobsAtPaths", () => {
  it("resolves blobs at the root and in nested directories", async () => {
    const ops = fakeOps({
      "": [
        blob("Header.json", "b1"),
        { ...blob("blocks", "t1"), type: "tree" },
      ],
      blocks: [blob("Footer.json", "b2")],
    });

    const result = await resolveBlobsAtPaths(
      "root",
      ["Header.json", "blocks/Footer.json"],
      ops,
    );

    expect(result.get("Header.json")?.sha).toBe("b1");
    expect(result.get("blocks/Footer.json")?.sha).toBe("b2");
  });

  it("omits a path missing at this commit instead of throwing", async () => {
    const ops = fakeOps({ "": [blob("Header.json", "b1")] });

    const result = await resolveBlobsAtPaths(
      "root",
      ["Header.json", "Deleted.json"],
      ops,
    );

    expect(result.has("Header.json")).toBe(true);
    expect(result.has("Deleted.json")).toBe(false);
  });

  it("omits every path under a directory that does not exist", async () => {
    const ops = fakeOps({ "": [] });

    const result = await resolveBlobsAtPaths(
      "root",
      ["missing/dir/File.json"],
      ops,
    );

    expect(result.size).toBe(0);
  });

  it("lists a shared directory once for paths in the same directory", async () => {
    let listings = 0;
    const dirs = { "": [blob("A.json", "a"), blob("B.json", "b")] };
    const ops = {
      resolveSubtreeSha: fakeOps(dirs).resolveSubtreeSha,
      treeShallow: (treeSha: string) => {
        listings++;
        return fakeOps(dirs).treeShallow(treeSha);
      },
    };

    await resolveBlobsAtPaths("root", ["A.json", "B.json"], ops);

    expect(listings).toBe(1);
  });
});
