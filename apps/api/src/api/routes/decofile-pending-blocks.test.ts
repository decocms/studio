/**
 * Fast Preview with the org's `cms_auto_commit` flag off: a save is held in
 * Studio instead of committed, every read lays it over the branch head, and
 * publishing commits it in one commit before merging. The repository is an
 * in-memory fake whose commits apply to its files; the pending store is an
 * in-memory stand-in for the `decofile_pending_blocks` table.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { decoBlockFingerprint } from "@decocms/shared/decofile";
import type { RepoRef } from "@decocms/shared/git-providers";
import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import type { FileChange, RepoContentClient, TreeEntry } from "@/git-providers";
import type {
  DecofilePendingBlockStorage,
  PendingBranchScope,
} from "@/storage/decofile-pending-blocks";
import type { DecofilePendingBlock } from "@/storage/types";
import type { Env } from "../hono-env";
import { createDecofileRoutes } from "./decofile";

beforeAll(() => {
  // No disk blob cache: every read goes to the fake repository.
  process.env.FAST_PREVIEW_CACHE_DIR = "";
});

const ORG = "org";
const REPO: RepoRef = {
  provider: "github",
  host: "github.com",
  path: "acme/pending-blocks",
};
const PROJECT = {
  previewServerUrl: "https://www.acme.test",
  repository: { owner: "acme", name: "pending-blocks" },
};
const HOME = { __resolveType: "page", name: "Home" };

/** `draft` forked from `main`; commits on it apply to its files. */
function fakeRepo() {
  const files = new Map<string, string>([
    [".deco/blocks/pages-home.json", JSON.stringify(HOME)],
  ]);
  const commits: Array<{ message: string; changes: FileChange[] }> = [];
  const merges: string[] = [];
  const head = () => `head${commits.length}`;
  const client = {
    repo: REPO,
    getDefaultBranch: async () => "main",
    getBranch: async (branch: string) =>
      branch === "draft" || branch === "main" ? { sha: head() } : null,
    getArchive: async () => null,
    readCommit: async () => null,
    listDecofileEntries: async (): Promise<TreeEntry[]> =>
      [...files.keys()].map((path) => ({
        path,
        type: "blob",
        sha: `${path}#${head()}`,
      })),
    getEntriesAtPaths: async () => new Map(),
    readBlob: async (sha: string) => files.get(sha.split("#")[0] ?? "") ?? "{}",
    readFileAtRef: async () => null,
    commitFiles: async (input: { message: string; changes: FileChange[] }) => {
      for (const change of input.changes) {
        if ("deleted" in change && change.deleted) files.delete(change.path);
        else if ("content" in change && typeof change.content === "string") {
          files.set(change.path, change.content);
        }
      }
      commits.push({ message: input.message, changes: input.changes });
      return { sha: head() };
    },
    createBranch: async () => {},
    mergeBranches: async (base: string, branch: string) => {
      merges.push(`${branch}->${base}`);
      return "merged";
    },
    compare: async () => ({ aheadBy: 0, behindBy: 0 }),
  } as unknown as RepoContentClient;
  return { client, files, commits, merges };
}

/** The table's behavior: one row per block, a new revision on every write. */
function memoryPendingStore() {
  const rows = new Map<string, DecofilePendingBlock>();
  let revision = 0;
  const store: Pick<
    DecofilePendingBlockStorage,
    "list" | "write" | "deleteRevisions" | "deleteKeys"
  > = {
    list: async (_scope: PendingBranchScope) =>
      [...rows.values()].sort((a, b) => a.blockKey.localeCompare(b.blockKey)),
    write: async (_scope, patch, _user, check) => {
      await check(new Map(rows));
      for (const [key, value] of Object.entries(patch.set)) {
        rows.set(key, {
          blockKey: key,
          content: value as Record<string, unknown>,
          revision: String(++revision),
        });
      }
      for (const key of patch.delete) {
        rows.set(key, {
          blockKey: key,
          content: null,
          revision: String(++revision),
        });
      }
    },
    deleteRevisions: async (_scope, blocks) => {
      for (const b of blocks) {
        if (rows.get(b.blockKey)?.revision === b.revision) {
          rows.delete(b.blockKey);
        }
      }
    },
    deleteKeys: async (_scope, keys) => {
      for (const key of keys) rows.delete(key);
    },
  };
  return { store, rows };
}

function setup(initialFlags: Record<string, unknown>) {
  const settings = { flags: initialFlags };
  const pending = memoryPendingStore();
  const ctx = {
    organization: { id: ORG, slug: ORG },
    auth: { user: { id: "user", role: "owner" } },
    access: { getRole: () => "owner", check: async () => {} },
    storage: {
      organizationSettings: { get: async () => settings },
      decofilePendingBlocks: pending.store,
      virtualMcps: {
        findById: async (id: string) =>
          id === "p1"
            ? { id, organization_id: ORG, metadata: PROJECT, connections: [] }
            : null,
      },
    },
  } as unknown as StudioContext;
  const repo = fakeRepo();
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("studioContext", ctx);
    await next();
  });
  app.route(
    "/decofile",
    createDecofileRoutes({ repoClientFor: async () => repo.client }),
  );
  return { app, repo, pending, settings };
}

const OFF = { cms_auto_commit: false };

function patch(app: Hono<Env>, body: unknown) {
  return app.request("/decofile/p1/draft", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function read(app: Hono<Env>) {
  const res = await app.request("/decofile/p1/draft");
  return (await res.json()) as {
    version: string;
    decofile: Record<string, unknown>;
  };
}

describe("a Fast Preview save with auto-commit off", () => {
  it("is held, not committed, and every read shows it over the head", async () => {
    const { app, repo, pending } = setup(OFF);
    const res = await patch(app, {
      set: { "pages-home": { ...HOME, name: "Held" } },
      delete: ["pages-missing"],
    });
    expect(res.status).toBe(200);
    const { version } = (await res.json()) as { version: string };
    expect(repo.commits).toHaveLength(0);
    expect(pending.rows.size).toBe(2);

    // The runtime takes `[A-Za-z0-9._-]{1,64}` and caches per version.
    expect(version).toMatch(/^head0\.[0-9a-f]{16}$/);
    const draft = await read(app);
    expect(draft.version).toBe(version);
    expect(draft.decofile["pages-home"]).toEqual({ ...HOME, name: "Held" });
    expect("pages-missing" in draft.decofile).toBe(false);
  });

  it("gives every save a new version, and answers 304 to the current one", async () => {
    const { app } = setup(OFF);
    const first = (await (
      await patch(app, { set: { "pages-home": { ...HOME, name: "One" } } })
    ).json()) as { version: string };
    const second = (await (
      await patch(app, { set: { "pages-home": { ...HOME, name: "Two" } } })
    ).json()) as { version: string };
    expect(second.version).not.toBe(first.version);
    const res = await app.request("/decofile/p1/draft", {
      headers: { "if-none-match": `"${second.version}"` },
    });
    expect(res.status).toBe(304);
  });

  it("checks `expect` against the held copy, not the head", async () => {
    const { app } = setup(OFF);
    const held = { ...HOME, name: "Held" };
    await patch(app, { set: { "pages-home": held } });

    const againstHead = await patch(app, {
      set: { "pages-home": { ...HOME, name: "Stale" } },
      expect: { "pages-home": await decoBlockFingerprint(HOME) },
    });
    expect(againstHead.status).toBe(409);
    expect(await againstHead.json()).toMatchObject({
      code: "block-conflict",
      blocks: ["pages-home"],
    });

    const againstHeld = await patch(app, {
      set: { "pages-home": { ...HOME, name: "Next" } },
      expect: { "pages-home": await decoBlockFingerprint(held) },
    });
    expect(againstHeld.status).toBe(200);
    expect((await read(app)).decofile["pages-home"]).toEqual({
      ...HOME,
      name: "Next",
    });
  });

  it("is committed in one commit by publish, before the merge", async () => {
    const { app, repo, pending } = setup(OFF);
    await patch(app, { set: { "pages-home": { ...HOME, name: "A" } } });
    await patch(app, { set: { "pages-about": { __resolveType: "page" } } });

    const res = await app.request("/decofile/p1/draft/publish", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(repo.commits).toHaveLength(1);
    expect(repo.merges).toEqual(["draft->main"]);
    expect(pending.rows.size).toBe(0);
    expect(
      JSON.parse(repo.files.get(".deco/blocks/pages-home.json") ?? "{}"),
    ).toEqual({ ...HOME, name: "A" });
    expect(repo.files.has(".deco/blocks/pages-about.json")).toBe(true);
  });
});

describe("a save once auto-commit is back on", () => {
  it("commits what was held first, then itself, and clears the rows", async () => {
    const { app, repo, pending, settings } = setup(OFF);
    await patch(app, { set: { "pages-about": { __resolveType: "page" } } });
    settings.flags = {};

    const res = await patch(app, {
      set: { "pages-home": { ...HOME, name: "Live" } },
    });
    expect(res.status).toBe(200);
    expect(repo.commits).toHaveLength(2);
    expect(pending.rows.size).toBe(0);
    expect(repo.files.has(".deco/blocks/pages-about.json")).toBe(true);
    expect(
      JSON.parse(repo.files.get(".deco/blocks/pages-home.json") ?? "{}"),
    ).toEqual({ ...HOME, name: "Live" });
  });
});
