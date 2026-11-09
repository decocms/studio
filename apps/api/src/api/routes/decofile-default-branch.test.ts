/**
 * The v7 default-branch guard at the route: production is never a draft, so a
 * decofile write aimed at the repository's default branch is refused with
 * `default_branch_read_only` and commits nothing, while the same write on a
 * draft branch commits, and reads of the default branch stay served.
 * The repository is an in-memory fake that records every client call.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { RepoRef } from "@decocms/shared/git-providers";
import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import type { RepoContentClient, TreeEntry } from "@/git-providers";
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
  path: "acme/default-branch-guard",
};
const PROJECT = {
  previewServerUrl: "https://www.acme.test",
  repository: { owner: "acme", name: "default-branch-guard" },
};
const FILES: Record<string, string> = {
  ".deco/blocks/pages-home.json": '{"__resolveType":"page"}',
};

/**
 * A repo with one branch, `main`, whose every client call is recorded
 * (method + args). `defaultBranch` renames the repo's default so `main` can
 * stand for a draft.
 */
function recordedRepo(options: { defaultBranch?: string } = {}) {
  const calls: string[] = [];
  let commits = 0;
  const tree = (): TreeEntry[] =>
    Object.keys(FILES).map((path) => ({ path, type: "blob", sha: path }));
  const target = {
    repo: REPO,
    getDefaultBranch: async () => options.defaultBranch ?? "main",
    getBranch: async (branch: string) =>
      branch === "main" ? { sha: `head${commits}` } : null,
    getArchive: async () => null,
    listDecofileEntries: async () => tree(),
    getEntriesAtPaths: async () => new Map(),
    readBlob: async (sha: string) => FILES[sha] ?? "{}",
    readFileAtRef: async () => null,
    commitFiles: async () => {
      commits++;
      return { sha: `head${commits}` };
    },
    createBranch: async () => {},
    compare: async () => ({ aheadBy: 0, behindBy: 0 }),
  };
  const client = new Proxy(target, {
    get(t, key, receiver) {
      const value = Reflect.get(t, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(`${String(key)} ${JSON.stringify(args)}`);
        return value.apply(t, args);
      };
    },
  }) as unknown as RepoContentClient;
  return { calls, repoClientFor: async () => client };
}

function setup(repoOptions: { defaultBranch?: string } = {}) {
  const ctx = {
    organization: { id: ORG, slug: ORG },
    auth: { user: { id: "user", role: "owner" } },
    access: { getRole: () => "owner", check: async () => {} },
    storage: {
      virtualMcps: {
        findById: async (id: string) =>
          id === "p1"
            ? {
                id,
                organization_id: ORG,
                metadata: PROJECT,
                connections: [],
              }
            : null,
      },
    },
  } as unknown as StudioContext;
  const repo = recordedRepo(repoOptions);
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("studioContext", ctx);
    await next();
  });
  app.route(
    "/decofile",
    createDecofileRoutes({ repoClientFor: repo.repoClientFor }),
  );
  return { app, repo };
}

describe("v7 writes to the default branch", () => {
  const patchHome = (app: Hono<Env>) =>
    app.request("/decofile/p1/main", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        set: { "pages-home": { __resolveType: "page", name: "Home" } },
      }),
    });

  it("refuses a PATCH on the default branch and commits nothing", async () => {
    const { app, repo } = setup();
    const res = await patchHome(app);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "default_branch_read_only",
    });
    expect(repo.calls.some((c) => c.startsWith("commitFiles"))).toBe(false);
  });

  it("commits the same PATCH when the branch is a draft", async () => {
    const { app, repo } = setup({ defaultBranch: "production" });
    const res = await patchHome(app);
    expect(res.status).toBe(200);
    expect(repo.calls.some((c) => c.startsWith("commitFiles"))).toBe(true);
  });

  it("still reads the default branch: the editor's GET and its status", async () => {
    // This branch has no decofile rpc (main's `schema.get`); the status read
    // is the other editor read of the default branch.
    const { app } = setup();
    expect((await app.request("/decofile/p1/main")).status).toBe(200);
    const status = await app.request("/decofile/p1/main/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ baseBranch: "main" });
  });
});
