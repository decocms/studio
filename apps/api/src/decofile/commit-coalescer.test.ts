import { beforeAll, describe, expect, it } from "bun:test";
import type { GitAuthor } from "@decocms/sandbox/shared";
import type { RepoRef } from "@decocms/shared/git-providers";
import type {
  BranchPage,
  FileChange,
  RepoContentClient,
  TreeEntry,
} from "@/git-providers";
import { RepoWriteConflict } from "@/git-providers";
import { decoBlockFingerprint } from "@decocms/shared/decofile";
import { BlockConflictError, enqueueDecofilePatch } from "./commit-coalescer";
import { resolveBlockContents } from "./read-decofile";

/**
 * These cover the blob-read cost of a decofile save. Regenerating the tracked
 * `.deco/blocks.gen.json` artifact touches EVERY block, so an uncached or
 * unbounded read there is a whole-repo blob fetch per save — which spent an
 * entire GitHub App installation's hourly REST budget in production.
 *
 * The disk blob cache is switched off here (`FAST_PREVIEW_CACHE_DIR=""`), so
 * these assert the two protections that survive without it: per-sha dedup +
 * the in-memory memo threaded across CAS attempts, and the concurrency bound.
 */
beforeAll(() => {
  process.env.FAST_PREVIEW_CACHE_DIR = "";
});

const REPO: RepoRef = {
  provider: "github",
  host: "github.com",
  path: "acme/site",
};

interface FakeOpts {
  /** Block stems present in the tree at HEAD. */
  stems: string[];
  /** Whether the repo tracks the merged `.deco/blocks.gen.json` artifact. */
  tracksGen: boolean;
  /** Reject this many `commitFiles` calls with a conflict before accepting. */
  conflicts?: number;
}

function fakeClient(opts: FakeOpts) {
  const readBlobCalls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let commitAttempts = 0;
  let committed: FileChange[] = [];
  let lastCommit: { message: string; author?: GitAuthor | null } | null = null;

  const treeEntries = (): TreeEntry[] => [
    ...opts.stems.map(
      (s): TreeEntry => ({
        path: `.deco/blocks/${s}.json`,
        type: "blob",
        sha: `sha-${s}`,
      }),
    ),
    ...(opts.tracksGen
      ? [
          {
            path: ".deco/blocks.gen.json",
            type: "blob" as const,
            sha: "sha-gen",
          },
        ]
      : []),
  ];

  const client: RepoContentClient = {
    repo: REPO,
    getDefaultBranch: async () => "main",
    getBranch: async () => ({ sha: "head1" }),
    searchBranches: async (): Promise<BranchPage> => ({
      branches: [],
      totalCount: 0,
      nextCursor: null,
    }),
    getArchive: async () => null,
    listDecofileEntries: async () => treeEntries(),
    getEntriesAtPaths: async () => new Map(),
    readBlob: async (sha: string) => {
      readBlobCalls.push(sha);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield so concurrent callers actually overlap.
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      const stem = sha.replace(/^sha-/, "");
      return JSON.stringify({ __resolveType: stem });
    },
    readFileAtRef: async () => null,
    commitFiles: async ({
      changes,
      message,
      author,
    }: {
      changes: FileChange[];
      message: string;
      author?: GitAuthor | null;
    }) => {
      commitAttempts++;
      if (commitAttempts <= (opts.conflicts ?? 0)) {
        throw new RepoWriteConflict("head moved");
      }
      committed = changes;
      lastCommit = { message, author };
      return { sha: `commit${commitAttempts}` };
    },
    createBranch: async () => {},
    forceBranchHead: async () => {},
    mergeBranches: async () => true,
    compare: async () => ({ ahead: 0, behind: 0 }),
  } as unknown as RepoContentClient;

  return {
    client,
    readBlobCalls,
    get maxInFlight() {
      return maxInFlight;
    },
    get commitAttempts() {
      return commitAttempts;
    },
    get committed() {
      return committed;
    },
    get lastCommit() {
      return lastCommit;
    },
  };
}

describe("enqueueDecofilePatch attribution", () => {
  const deps = (f: ReturnType<typeof fakeClient>, coAuthor?: unknown) => ({
    client: f.client,
    branch: "feature",
    packagePath: null,
    coAuthor: coAuthor as never,
  });

  it("makes the editor the commit author, with no trailer repeating them", async () => {
    const f = fakeClient({ stems: ["Header"], tracksGen: false });
    await enqueueDecofilePatch(
      `q-author-${Date.now()}`,
      deps(f, { userName: "Ana", userEmail: "ana@acme.com" }),
      { set: { Header: { __resolveType: "Header" } } },
    );
    expect(f.lastCommit?.author).toEqual({
      name: "Ana",
      email: "ana@acme.com",
    });
    expect(f.lastCommit?.message).toBe("chore(decofile): update Header");
  });

  it("leaves the commit to the bot when the flag is off", async () => {
    const f = fakeClient({ stems: ["Header"], tracksGen: false });
    await enqueueDecofilePatch(
      `q-flagged-off-${Date.now()}`,
      deps(f, {
        userName: "Ana",
        userEmail: "ana@acme.com",
        authorsCommit: false,
      }),
      { set: { Header: { __resolveType: "Header" } } },
    );
    expect(f.lastCommit?.author).toBeNull();
    expect(f.lastCommit?.message).toBe(
      "chore(decofile): update Header\n\nCo-authored-by: Ana <ana@acme.com>",
    );
  });

  it("falls back to the trailer when the editor has no usable email", async () => {
    const f = fakeClient({ stems: ["Header"], tracksGen: false });
    await enqueueDecofilePatch(
      `q-trailer-${Date.now()}`,
      deps(f, { userName: "Ana" }),
      { set: { Header: { __resolveType: "Header" } } },
    );
    expect(f.lastCommit?.author).toBeNull();
    expect(f.lastCommit?.message).toBe(
      "chore(decofile): update Header\n\nCo-authored-by: Ana",
    );
  });
});

describe("resolveBlockContents", () => {
  it("passes through in-hand content without a fetch", async () => {
    const f = fakeClient({ stems: [], tracksGen: false });
    const out = await resolveBlockContents(f.client, [
      { stem: "A", content: "a" },
      { stem: "B", content: "b" },
    ]);
    expect(out).toEqual([
      { stem: "A", content: "a" },
      { stem: "B", content: "b" },
    ]);
    expect(f.readBlobCalls).toEqual([]);
  });

  it("fetches each distinct sha exactly once, preserving input order", async () => {
    const f = fakeClient({ stems: [], tracksGen: false });
    const out = await resolveBlockContents(f.client, [
      { stem: "A", sha: "sha-A" },
      { stem: "B", sha: "sha-B" },
      // Same blob reached by a second stem: one fetch, both resolved.
      { stem: "B-alias", sha: "sha-B" },
    ]);
    expect(out.map((o) => o.stem)).toEqual(["A", "B", "B-alias"]);
    expect(out[1]?.content).toBe(out[2]?.content);
    expect(f.readBlobCalls.sort()).toEqual(["sha-A", "sha-B"]);
  });

  it("reuses a caller-provided memo instead of refetching", async () => {
    const f = fakeClient({ stems: [], tracksGen: false });
    const memo = new Map<string, string>();
    const blocks = [{ stem: "A", sha: "sha-A" }];

    await resolveBlockContents(f.client, blocks, memo);
    expect(f.readBlobCalls).toEqual(["sha-A"]);

    await resolveBlockContents(f.client, blocks, memo);
    expect(f.readBlobCalls).toEqual(["sha-A"]); // no second read
  });

  it("bounds concurrency rather than fanning out over every block", async () => {
    const f = fakeClient({ stems: [], tracksGen: false });
    const blocks = Array.from({ length: 200 }, (_, i) => ({
      stem: `B${i}`,
      sha: `sha-B${i}`,
    }));
    await resolveBlockContents(f.client, blocks);
    expect(f.readBlobCalls).toHaveLength(200);
    // The whole point: NOT 200 concurrent requests.
    expect(f.maxInFlight).toBeLessThanOrEqual(12);
  });
});

describe("enqueueDecofilePatch blob cost", () => {
  const stems = Array.from({ length: 50 }, (_, i) => `Block${i}`);

  it("reads no blobs at all when the repo does not track blocks.gen.json", async () => {
    const f = fakeClient({ stems, tracksGen: false });
    await enqueueDecofilePatch(
      `q-untracked-${Date.now()}`,
      {
        client: f.client,
        branch: "feature",
        packagePath: null,
      },
      { set: { Block0: { __resolveType: "Block0" } } },
    );

    expect(f.readBlobCalls).toEqual([]);
  });

  it("reads each other block once when regenerating blocks.gen.json", async () => {
    const f = fakeClient({ stems, tracksGen: true });
    await enqueueDecofilePatch(
      `q-tracked-${Date.now()}`,
      {
        client: f.client,
        branch: "feature",
        packagePath: null,
      },
      { set: { Block0: { __resolveType: "Block0" } } },
    );

    // The written block comes from the patch, not GitHub; the other 49 are read.
    expect(f.readBlobCalls).toHaveLength(stems.length - 1);
    expect(new Set(f.readBlobCalls).size).toBe(stems.length - 1);
    expect(f.readBlobCalls).not.toContain("sha-Block0");
    expect(f.maxInFlight).toBeLessThanOrEqual(12);
  });

  it("a CAS retry re-reads nothing it already resolved", async () => {
    const f = fakeClient({ stems, tracksGen: true, conflicts: 1 });
    await enqueueDecofilePatch(
      `q-retry-${Date.now()}`,
      {
        client: f.client,
        branch: "feature",
        packagePath: null,
      },
      { set: { Block0: { __resolveType: "Block0" } } },
    );

    expect(f.commitAttempts).toBe(2);
    // Was 2x the tree before the memo was hoisted out of the attempt loop.
    expect(f.readBlobCalls).toHaveLength(stems.length - 1);
  });

  it("still regenerates the artifact over every block", async () => {
    const f = fakeClient({ stems, tracksGen: true });
    await enqueueDecofilePatch(
      `q-gen-${Date.now()}`,
      {
        client: f.client,
        branch: "feature",
        packagePath: null,
      },
      { set: { Block0: { __resolveType: "Block0" } } },
    );

    const gen = f.committed.find((c) => c.path === ".deco/blocks.gen.json");
    expect(gen).toBeDefined();
    const doc = JSON.parse(
      (gen as { path: string; content: string }).content,
    ) as Record<string, unknown>;
    expect(Object.keys(doc)).toHaveLength(stems.length);
  });
});

describe("enqueueDecofilePatch expectations", () => {
  const stems = ["Header", "Footer"];
  const deps = (f: ReturnType<typeof fakeClient>) => ({
    client: f.client,
    branch: "feature",
    packagePath: null,
  });
  // The fake serves `{ __resolveType: <stem> }` for every block at head.
  const headFingerprint = (stem: string) =>
    decoBlockFingerprint({ __resolveType: stem });

  it("commits a write made against the block the branch still has", async () => {
    const f = fakeClient({ stems, tracksGen: false });
    const sha = await enqueueDecofilePatch(
      `q-expect-ok-${Date.now()}`,
      deps(f),
      {
        set: { Header: { __resolveType: "Header", title: "new" } },
        expect: { Header: await headFingerprint("Header") },
      },
    );
    expect(sha).toBe("commit1");
    expect(f.committed.map((c) => c.path)).toEqual([
      ".deco/blocks/Header.json",
    ]);
  });

  it("rejects, writing nothing, a whole-block write made against an older version", async () => {
    const f = fakeClient({ stems, tracksGen: false });
    const stale = await decoBlockFingerprint({
      __resolveType: "Header",
      menu: ["what the editor loaded before someone else published"],
    });
    const write = enqueueDecofilePatch(
      `q-expect-stale-${Date.now()}`,
      deps(f),
      {
        set: { Header: { __resolveType: "Header", title: "new" } },
        expect: { Header: stale },
      },
    );
    await expect(write).rejects.toBeInstanceOf(BlockConflictError);
    await expect(write).rejects.toMatchObject({ blocks: ["Header"] });
    expect(f.commitAttempts).toBe(0);
  });

  it("treats null as 'the editor saw no such block'", async () => {
    const f = fakeClient({ stems, tracksGen: false });
    const queue = `q-expect-null-${Date.now()}`;
    await expect(
      enqueueDecofilePatch(queue, deps(f), {
        set: { Banner: { __resolveType: "Banner" } },
        expect: { Banner: null },
      }),
    ).resolves.toBe("commit1");
    await expect(
      enqueueDecofilePatch(queue, deps(f), {
        set: { Footer: { __resolveType: "Footer", x: 1 } },
        expect: { Footer: null },
      }),
    ).rejects.toBeInstanceOf(BlockConflictError);
  });

  it("checks a coalesced patch against the writes queued before it", async () => {
    const f = fakeClient({ stems, tracksGen: false });
    const queue = `q-expect-order-${Date.now()}`;
    const headerAtHead = await headFingerprint("Header");
    const first = { __resolveType: "Header", title: "first" };
    const afterFirst = await decoBlockFingerprint(first);

    // Holds the queue so the next three land in ONE batch.
    const blocker = enqueueDecofilePatch(queue, deps(f), {
      set: { Footer: { __resolveType: "Footer", x: 1 } },
    });
    const accepted = enqueueDecofilePatch(queue, deps(f), {
      set: { Header: first },
      expect: { Header: headerAtHead },
    });
    // Made against the head, but `first` replaces it earlier in the same commit.
    const overtaken = enqueueDecofilePatch(queue, deps(f), {
      set: { Header: { __resolveType: "Header", title: "stale" } },
      expect: { Header: headerAtHead },
    });
    // Made against `first`, so it builds on it.
    const followUp = enqueueDecofilePatch(queue, deps(f), {
      set: { Header: { __resolveType: "Header", title: "second" } },
      expect: { Header: afterFirst },
    });

    const [, ...results] = await Promise.allSettled([
      blocker,
      accepted,
      overtaken,
      followUp,
    ]);
    expect(results.map((r) => r.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    expect(results[0]).toMatchObject({ value: "commit2" });
    expect(results[1]).toMatchObject({
      reason: expect.any(BlockConflictError),
    });
    const header = f.committed.find(
      (c) => c.path === ".deco/blocks/Header.json",
    ) as { content: string };
    expect(JSON.parse(header.content)).toEqual({
      __resolveType: "Header",
      title: "second",
    });
  });
});
