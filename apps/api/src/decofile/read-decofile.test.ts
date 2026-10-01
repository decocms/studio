import { describe, expect, it } from "bun:test";
import type { RepoContentClient, TreeEntry } from "@/git-providers";
import {
  aliasPathsForKey,
  blockEntriesInTree,
  blocksDirPath,
  gitBlobSha,
  invalidateMemoizedBranchHead,
  memoizedBranchHead,
} from "./read-decofile";

function blob(path: string): TreeEntry {
  return { path, type: "blob", sha: `sha-${path}` };
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
      { path: ".deco/blocks", type: "tree", sha: "t" },
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

describe("gitBlobSha", () => {
  /** The object ids git itself produces — the cache is keyed by the sha the
   *  provider's tree listing reports, so a mismatch is a silent cache miss. */
  it("matches git's blob hashing, including for an empty file", () => {
    expect(gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(gitBlobSha("hello\n")).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
  });

  it("hashes byte length, not code-point length", () => {
    expect(gitBlobSha("é")).toBe(gitBlobSha("\u00e9"));
    expect(gitBlobSha("é")).not.toBe(gitBlobSha("e"));
  });
});

describe("memoizedBranchHead", () => {
  function fakeClient() {
    const state = { sha: "a", calls: 0 };
    const client = {
      repo: {
        provider: "github",
        host: "github.com",
        path: `acme/app-${Math.random()}`,
      },
      getBranch: async () => {
        state.calls++;
        return { sha: state.sha };
      },
    } as unknown as RepoContentClient;
    return { client, state };
  }

  it("asks the provider once per branch while fresh, concurrent polls included", async () => {
    const { client, state } = fakeClient();
    const heads = await Promise.all([
      memoizedBranchHead(client, "draft"),
      memoizedBranchHead(client, "draft"),
    ]);
    expect(await memoizedBranchHead(client, "draft")).toBe("a");
    expect(heads).toEqual(["a", "a"]);
    expect(state.calls).toBe(1);
    await memoizedBranchHead(client, "other");
    expect(state.calls).toBe(2);
  });

  it("a write invalidates it, even with a lookup in flight", async () => {
    const { client, state } = fakeClient();
    expect(await memoizedBranchHead(client, "draft")).toBe("a");
    state.sha = "b";
    invalidateMemoizedBranchHead(client.repo, "draft");
    expect(await memoizedBranchHead(client, "draft")).toBe("b");

    // A lookup that started before the write must not memoize its old answer.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const slow = {
      ...client,
      repo: { ...client.repo, path: `${client.repo.path}-slow` },
      getBranch: async () => {
        if (calls++ > 0) return { sha: "new" };
        await gate;
        return { sha: "old" };
      },
    } as unknown as RepoContentClient;
    const pending = memoizedBranchHead(slow, "draft");
    invalidateMemoizedBranchHead(slow.repo, "draft");
    release();
    expect(await pending).toBe("old");
    expect(await memoizedBranchHead(slow, "draft")).toBe("new");
  });
});
