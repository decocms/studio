import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  type ChangeSources,
  GithubContentClient,
  mapGithubPull,
  resolveEntriesAtPaths,
  treeWriteEntries,
} from "./content";
import type { TreeEntry } from "../content";

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
  type: "blob",
  sha,
});

describe("resolveEntriesAtPaths", () => {
  it("resolves blobs at the root and in nested directories", async () => {
    const ops = fakeOps({
      "": [
        blob("Header.json", "b1"),
        { ...blob("blocks", "t1"), type: "tree" },
      ],
      blocks: [blob("Footer.json", "b2")],
    });

    const result = await resolveEntriesAtPaths(
      "root",
      ["Header.json", "blocks/Footer.json"],
      ops,
    );

    expect(result.get("Header.json")?.sha).toBe("b1");
    expect(result.get("blocks/Footer.json")?.sha).toBe("b2");
  });

  it("omits a path missing at this commit instead of throwing", async () => {
    const ops = fakeOps({ "": [blob("Header.json", "b1")] });

    const result = await resolveEntriesAtPaths(
      "root",
      ["Header.json", "Deleted.json"],
      ops,
    );

    expect(result.has("Header.json")).toBe(true);
    expect(result.has("Deleted.json")).toBe(false);
  });

  it("omits every path under a directory that does not exist", async () => {
    const ops = fakeOps({ "": [] });

    const result = await resolveEntriesAtPaths(
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

    await resolveEntriesAtPaths("root", ["A.json", "B.json"], ops);

    expect(listings).toBe(1);
  });
});

describe("treeWriteEntries", () => {
  /** Nothing exists at any ref unless a test says so. */
  const uploads: ChangeSources = {
    blobSha: (change) => `blob:${change.path}`,
    copySource: () => null,
  };

  it("maps a write to its blob and a deletion to a null sha", () => {
    const entries = treeWriteEntries(
      [
        { path: ".deco/blocks/Hero.json", content: "{}\n" },
        { path: ".deco/blocks/Old.json", deleted: true },
      ],
      uploads,
    );

    expect(entries).toEqual([
      {
        path: ".deco/blocks/Hero.json",
        mode: "100644",
        type: "blob",
        sha: "blob:.deco/blocks/Hero.json",
      },
      {
        path: ".deco/blocks/Old.json",
        mode: "100644",
        type: "blob",
        sha: null,
      },
    ]);
  });

  it("sends a write's text inline when no blob was uploaded for it (hosted Publish)", () => {
    const entries = treeWriteEntries(
      [
        { path: ".deco/blocks/Hero.json", content: "{}\n" },
        { path: ".deco/blocks/Old.json", deleted: true },
      ],
      { ...uploads, blobSha: () => null },
    );

    expect(entries).toEqual([
      {
        path: ".deco/blocks/Hero.json",
        mode: "100644",
        type: "blob",
        content: "{}\n",
      },
      {
        path: ".deco/blocks/Old.json",
        mode: "100644",
        type: "blob",
        sha: null,
      },
    ]);
  });

  it("keeps the caller's order, since the last entry for a path wins", () => {
    const entries = treeWriteEntries(
      [
        { path: "A.json", deleted: true },
        { path: "A.json", content: "{}\n" },
      ],
      { ...uploads, blobSha: () => "b1" },
    );

    expect(entries.map((e) => e.sha)).toEqual([null, "b1"]);
  });

  it("asks for a blob only for the paths that carry content", () => {
    const asked: string[] = [];
    treeWriteEntries(
      [
        { path: "A.json", deleted: true },
        { path: "B.json", content: "{}\n" },
        { path: "C.json", copyFromRef: "base" },
      ],
      {
        blobSha: (change) => {
          asked.push(change.path);
          return "b1";
        },
        copySource: () => ({ sha: "c1", mode: "100644" }),
      },
    );

    expect(asked).toEqual(["B.json"]);
  });

  it("points a copy at the sha already in the source ref's tree", () => {
    const entries = treeWriteEntries(
      [{ path: "A.json", copyFromRef: "merge-base" }],
      {
        ...uploads,
        copySource: (ref, path) =>
          ref === "merge-base" && path === "A.json"
            ? { sha: "existing", mode: "100644" }
            : null,
      },
    );

    expect(entries).toEqual([
      { path: "A.json", mode: "100644", type: "blob", sha: "existing" },
    ]);
  });

  it("carries the source entry's mode through a copy, so an executable file stays executable", () => {
    const entries = treeWriteEntries(
      [{ path: "run.sh", copyFromRef: "merge-base" }],
      { ...uploads, copySource: () => ({ sha: "s", mode: "100755" }) },
    );

    expect(entries[0]?.mode).toBe("100755");
  });

  it("keeps a symlink a symlink rather than folding it into a regular file", () => {
    const entries = treeWriteEntries([{ path: "link", copyFromRef: "r" }], {
      ...uploads,
      copySource: () => ({ sha: "s", mode: "120000" }),
    });

    expect(entries[0]?.mode).toBe("120000");
  });

  it("takes the change's mode over the source's when it states one", () => {
    const entries = treeWriteEntries(
      [
        { path: "run.sh", content: "#!/bin/sh\n", mode: "100755" },
        { path: "copied.sh", copyFromRef: "r", mode: "100644" },
      ],
      { ...uploads, copySource: () => ({ sha: "s", mode: "100755" }) },
    );

    expect(entries.map((e) => e.mode)).toEqual(["100755", "100644"]);
  });

  it("fails loud when a copy source is not there, rather than deleting the path", () => {
    expect(() =>
      treeWriteEntries([{ path: "Gone.json", copyFromRef: "r" }], uploads),
    ).toThrow(/does not exist at r/);
  });

  it("rejects an empty path", () => {
    expect(() =>
      treeWriteEntries([{ path: "", content: "{}" }], uploads),
    ).toThrow(/cannot be empty/);
  });

  it("rejects a path exceeding maximum length", () => {
    const longPath = "a".repeat(1025);
    expect(() =>
      treeWriteEntries([{ path: longPath, content: "{}" }], uploads),
    ).toThrow(/exceeds maximum length/);
  });

  it("rejects a path containing null bytes", () => {
    expect(() =>
      treeWriteEntries([{ path: "a\0b.json", content: "{}" }], uploads),
    ).toThrow(/cannot contain null bytes/);
  });

  it("rejects reserved Git file names", () => {
    for (const reserved of [".gitmodules"]) {
      expect(() =>
        treeWriteEntries([{ path: reserved, content: "{}" }], uploads),
      ).toThrow(/reserved Git file name/);

      expect(() =>
        treeWriteEntries([{ path: `dir/${reserved}`, content: "{}" }], uploads),
      ).toThrow(/reserved Git file name/);
    }
  });
});

describe("mapGithubPull", () => {
  it("reports a merged pull as merged, not closed", () => {
    expect(
      mapGithubPull({
        number: 7,
        html_url: "https://github.example/o/r/pull/7",
        title: "Publish draft",
        state: "closed",
        merged: true,
      }),
    ).toEqual({
      number: 7,
      url: "https://github.example/o/r/pull/7",
      title: "Publish draft",
      state: "merged",
    });
  });

  it("defaults to open for a response that omits the state", () => {
    const pull = mapGithubPull({
      number: 1,
      html_url: "https://github.example/o/r/pull/1",
    });
    expect(pull.state).toBe("open");
    expect(pull.title).toBe("");
  });

  it("keeps a closed-but-unmerged pull closed", () => {
    expect(
      mapGithubPull({
        number: 2,
        html_url: "u",
        state: "closed",
        merged: false,
      }).state,
    ).toBe("closed");
  });
});

describe("GithubContentClient.commitFiles with inline content", () => {
  const blobUploads: number[] = [];
  let treeBody: { tree: Array<Record<string, unknown>> } | null = null;
  let server: ReturnType<typeof Bun.serve>;
  const previousBase = process.env.GITHUB_API_BASE_URL;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const { pathname } = new URL(req.url);
        const body = req.method === "GET" ? null : await req.json();
        if (pathname.endsWith("/git/blobs")) {
          blobUploads.push((body as { content: string }).content.length);
          return Response.json({ sha: `blob${blobUploads.length}` });
        }
        if (pathname.endsWith("/git/trees")) {
          treeBody = body as typeof treeBody;
          return Response.json({ sha: "tree1" });
        }
        if (pathname.endsWith("/git/commits")) {
          return Response.json({ sha: "commit1" });
        }
        if (pathname.includes("/git/commits/")) {
          return Response.json({ tree: { sha: "tree0" } });
        }
        if (pathname.includes("/git/refs/heads/")) return Response.json({});
        return new Response(null, { status: 404 });
      },
    });
    process.env.GITHUB_API_BASE_URL = server.url.origin;
  });

  afterAll(() => {
    server.stop(true);
    if (previousBase === undefined) delete process.env.GITHUB_API_BASE_URL;
    else process.env.GITHUB_API_BASE_URL = previousBase;
  });

  it("uploads only a file over the inline cap as its own blob", async () => {
    const client = new GithubContentClient({
      repo: { provider: "github", host: "github.com", path: "acme/site" },
      tokenSource: {
        kind: "installation",
        get: async () => ({
          token: "t",
          kind: "installation",
          expiresAt: null,
        }),
      },
    });
    const big = "x".repeat(1024 * 1024 + 1);
    const { sha } = await client.commitFiles({
      branch: "feature",
      message: "save",
      expectedHead: "head0",
      inlineContent: true,
      changes: [
        { path: ".deco/blocks/Header.json", content: '{"a":1}' },
        { path: ".deco/blocks.gen.json", content: big },
      ],
    });

    expect(sha).toBe("commit1");
    expect(blobUploads).toEqual([big.length]);
    expect(treeBody?.tree).toEqual([
      {
        path: ".deco/blocks/Header.json",
        mode: "100644",
        type: "blob",
        content: '{"a":1}',
      },
      {
        path: ".deco/blocks.gen.json",
        mode: "100644",
        type: "blob",
        sha: "blob1",
      },
    ]);
  });
});
