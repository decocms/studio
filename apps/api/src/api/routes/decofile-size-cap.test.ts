/**
 * The decofile read refuses a site whose blocks exceed
 * FAST_PREVIEW_DECOFILE_MAX_BYTES with 413 `decofile-too-large`, instead of
 * merging it in the heap: a read holds about 8x its block bytes at peak, so an
 * oversized site OOM-killed the API process on every editor open.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import type { RepoContentClient, TreeEntry } from "@/git-providers";
import type { Env } from "../hono-env";
import { createDecofileRoutes } from "./decofile";

const ORG = "org";
const BLOCK = `{"__resolveType":"page","title":"${"x".repeat(80)}"}`;

beforeAll(() => {
  // No disk cache: every read merges from the fake repository.
  process.env.FAST_PREVIEW_CACHE_DIR = "";
  // Room for two blocks, not three.
  process.env.FAST_PREVIEW_DECOFILE_MAX_BYTES = String(BLOCK.length * 2);
});

afterAll(() => {
  delete process.env.FAST_PREVIEW_DECOFILE_MAX_BYTES;
});

let repoSeq = 0;

/** A repo with `blocks` identical blocks; `sized` controls whether the tree
 * reports blob sizes (GitHub does, GitLab doesn't). */
function setup(blocks: number, sized: boolean) {
  const blobReads: string[] = [];
  const tree: TreeEntry[] = Array.from({ length: blocks }, (_, i) => ({
    path: `.deco/blocks/pages-${i}.json`,
    type: "blob",
    sha: `sha-${i}`,
    ...(sized ? { size: BLOCK.length } : {}),
  }));
  const client = {
    // Unique per test: snapshot reads single-flight on (repo, sha).
    repo: {
      provider: "github",
      host: "github.com",
      path: `acme/r${++repoSeq}`,
    },
    getDefaultBranch: async () => "production",
    getBranch: async () => ({ sha: "head" }),
    getArchive: async () => null,
    listDecofileEntries: async () => tree,
    readBlob: async (sha: string) => {
      blobReads.push(sha);
      return BLOCK;
    },
  } as unknown as RepoContentClient;
  const ctx = {
    organization: { id: ORG, slug: ORG },
    auth: { user: { id: "user", role: "owner" } },
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
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("studioContext", ctx);
    await next();
  });
  app.route(
    "/decofile",
    createDecofileRoutes({ repoClientFor: async () => client }),
  );
  return { read: () => app.request("/decofile/p1/draft"), blobReads };
}

describe("decofile read size cap", () => {
  it("refuses an oversized tree before fetching any block", async () => {
    const { read, blobReads } = setup(3, true);
    const res = await read();
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "decofile-too-large" });
    expect(blobReads).toEqual([]);
  });

  it("refuses oversized content when the tree carries no sizes", async () => {
    const { read } = setup(3, false);
    const res = await read();
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "decofile-too-large" });
  });

  it("serves a decofile at the cap", async () => {
    const { read } = setup(2, true);
    const res = await read();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decofile: Record<string, unknown> };
    expect(Object.keys(body.decofile).sort()).toEqual(["pages-0", "pages-1"]);
  });
});
