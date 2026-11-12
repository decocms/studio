/**
 * The decofile GET streams the merged document instead of building it in the
 * heap, from the disk cache when it's on and from memory when it's off, and
 * refuses a site over FAST_PREVIEW_DECOFILE_MAX_BYTES with 413
 * `decofile-too-large`.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import { resetDecofileDiskCacheForTests } from "@/decofile/disk-cache";
import type { RepoContentClient, TreeEntry } from "@/git-providers";
import type { Env } from "../hono-env";
import { createDecofileRoutes } from "./decofile";

const ORG = "org";
const BLOCK = `{"__resolveType":"page","title":"${"x".repeat(80)}"}`;
const cacheDir = mkdtempSync(join(tmpdir(), "decofile-read-test-"));

function useCache(on: boolean) {
  process.env.FAST_PREVIEW_CACHE_DIR = on ? cacheDir : "";
  resetDecofileDiskCacheForTests();
}

beforeEach(() => {
  // Room for two BLOCKs, not three.
  process.env.FAST_PREVIEW_DECOFILE_MAX_BYTES = String(BLOCK.length * 2);
});

afterAll(() => {
  delete process.env.FAST_PREVIEW_DECOFILE_MAX_BYTES;
  useCache(false);
  rmSync(cacheDir, { recursive: true, force: true });
});

let repoSeq = 0;

/** A repo holding `blocks` (file stem -> content); `sized` controls whether
 * the tree reports blob sizes (GitHub does, GitLab doesn't). */
function setup(
  blocks: Record<string, string>,
  sized = true,
  archive: () => ReadableStream<Uint8Array> | null = () => null,
) {
  const calls = { tree: 0, blobs: [] as string[] };
  const tree: TreeEntry[] = Object.entries(blocks).map(([stem, content]) => ({
    path: `.deco/blocks/${stem}.json`,
    type: "blob",
    sha: Bun.hash(content).toString(16).padStart(40, "0"),
    ...(sized ? { size: content.length } : {}),
  }));
  const bySha = new Map(tree.map((e, i) => [e.sha, Object.values(blocks)[i]!]));
  const client = {
    // Unique per test: reads single-flight and cache on (repo, sha).
    repo: {
      provider: "github",
      host: "github.com",
      path: `acme/r${++repoSeq}`,
    },
    getDefaultBranch: async () => "production",
    getBranch: async () => ({ sha: "a".repeat(40) }),
    getArchive: async () => archive(),
    listDecofileEntries: async () => {
      calls.tree++;
      return tree;
    },
    readBlob: async (sha: string) => {
      calls.blobs.push(sha);
      return bySha.get(sha)!;
    },
  } as unknown as RepoContentClient;

  function app(user: boolean) {
    const ctx = {
      organization: { id: ORG, slug: ORG },
      auth: user ? { user: { id: "user", role: "owner" } } : {},
      access: { getRole: () => "owner", check: async () => {} },
      storage: {
        virtualMcps: {
          findById: async (id: string) => ({
            id,
            organization_id: ORG,
            metadata: {
              previewServerUrl: "https://www.acme.test",
              repository: { owner: "acme", name: "site" },
            },
            connections: [],
          }),
        },
      },
    } as unknown as StudioContext;
    const hono = new Hono<Env>();
    hono.use("*", async (c, next) => {
      c.set("studioContext", ctx);
      await next();
    });
    hono.route(
      "/decofile",
      createDecofileRoutes({ repoClientFor: async () => client }),
    );
    return hono;
  }

  return {
    calls,
    read: () => app(true).request("/decofile/p1/draft"),
    readAnonymous: (token: string) =>
      app(false).request(
        `/decofile/p1/draft?token=${encodeURIComponent(token)}`,
      ),
  };
}

for (const cache of [true, false]) {
  describe(`decofile GET (disk cache ${cache ? "on" : "off"})`, () => {
    beforeEach(() => useCache(cache));

    it("refuses an oversized tree before fetching any block", async () => {
      const { read, calls } = setup({ a: BLOCK, b: BLOCK, c: BLOCK });
      const res = await read();
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ code: "decofile-too-large" });
      expect(calls.blobs).toEqual([]);
    });

    it("refuses oversized content when the tree carries no sizes", async () => {
      const { read } = setup({ a: BLOCK, b: BLOCK, c: BLOCK }, false);
      const res = await read();
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ code: "decofile-too-large" });
    });

    it("streams the editor wrapper around the merged document", async () => {
      const { read } = setup({ "pages-1": BLOCK, "pages-0": BLOCK });
      const res = await read();
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        version: string;
        token: string;
        decofile: Record<string, unknown>;
      };
      expect(body.version).toBe("a".repeat(40));
      expect(body.token).toBeString();
      expect(Object.keys(body.decofile)).toEqual(["pages-0", "pages-1"]);
      expect(body.decofile["pages-0"]).toEqual(JSON.parse(BLOCK));
    });

    it("appends planning posts to the anonymous preview pull", async () => {
      process.env.FAST_PREVIEW_DECOFILE_MAX_BYTES = "";
      const { read, readAnonymous } = setup({
        "blog-manager%2Fposts%2Fabc": JSON.stringify({
          post: { slug: "guia", status: "draft" },
        }),
        home: BLOCK,
      });
      const { token } = (await (await read()).json()) as { token: string };
      const res = await readAnonymous(token);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(doc)).toEqual([
        "blog-manager/posts/abc",
        "home",
        "collections/blog/posts/abc",
      ]);
      expect(doc["collections/blog/posts/abc"]).toMatchObject({
        post: { slug: "guia", status: "published" },
      });
    });

    it("serves an empty site", async () => {
      const { read, readAnonymous } = setup({});
      const { token, decofile } = (await (await read()).json()) as {
        token: string;
        decofile: unknown;
      };
      expect(decofile).toEqual({});
      expect(await (await readAnonymous(token)).json()).toEqual({});
    });
  });
}

describe("decofile GET cache reuse", () => {
  beforeEach(() => useCache(true));

  it("serves a repeat read from the cached document without merging", async () => {
    const { read, calls } = setup({ a: BLOCK });
    const first = await (await read()).text();
    const second = await (await read()).text();
    expect(calls.tree).toBe(1);
    expect(JSON.parse(second).decofile).toEqual(JSON.parse(first).decofile);
  });
});

describe("decofile GET cold read", () => {
  beforeEach(() => useCache(true));

  it("merges a cold site from its tarball without blob fetches", async () => {
    process.env.FAST_PREVIEW_DECOFILE_MAX_BYTES = "";
    const blocks = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [
        `pages-${String(i).padStart(2, "0")}`,
        `{"n":${i}}`,
      ]),
    );
    const src = mkdtempSync(join(tmpdir(), "decofile-tar-"));
    const blocksDir = join(src, "repo-sha", ".deco", "blocks");
    mkdirSync(blocksDir, { recursive: true });
    for (const [stem, content] of Object.entries(blocks)) {
      writeFileSync(join(blocksDir, `${stem}.json`), content);
    }
    const tgz = join(src, "repo.tgz");
    Bun.spawnSync(["tar", "-czf", tgz, "-C", src, "repo-sha"]);
    try {
      const { read, calls } = setup(blocks, true, () => Bun.file(tgz).stream());
      const res = await read();
      expect(res.status).toBe(200);
      const { decofile } = (await res.json()) as {
        decofile: Record<string, unknown>;
      };
      expect(Object.keys(decofile)).toEqual(Object.keys(blocks));
      expect(decofile["pages-59"]).toEqual({ n: 59 });
      expect(calls.blobs).toEqual([]);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });
});
