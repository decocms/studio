/**
 * Route-level tests of the Blocks v8 gates: the refresh route
 * (`/blocks-major`), the hosted routes' middleware and the decofile routes.
 * Storage is in memory and the repository is a fake that records every call,
 * so "a v7 project costs nothing" is asserted, not assumed.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BLOCKS_MAJOR_METADATA_KEY } from "@decocms/shared/blocks-major";
import { PROJECT_SCOPE_KEY } from "@decocms/shared/auth/project-scope";
import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import type { RepoContentClient } from "@/git-providers";
import { fakeRepo, memoryKv, SCHEMA_TEXT } from "@/hosted/hosted-test-helpers";
import { getSettings, setGlobalSettings } from "@/settings";
import type { Env } from "../hono-env";
import { createBlocksMajorRoutes } from "./blocks-major";
import { createDecofileRoutes } from "./decofile";
import { createHostedRoutes } from "./hosted";

const V7_SCHEMA = '{\n  "definitions": {},\n  "root": {}\n}\n';
const ORG = "org";
const SITE = "acme";
const REPOSITORY = { owner: "acme", name: "site" };

interface Project {
  id: string;
  organization_id: string;
  metadata: Record<string, unknown> | null;
  connections: Array<{ connection_id: string }>;
}

/** A Studio context over in-memory projects and org_sites. */
function world(options: {
  projects: Project[];
  /** project id → the org that owns its site (absent: unlinked). */
  sites?: Record<string, string>;
  /** A project-scoped role's allowlist; absent: an admin. */
  projectScope?: string[];
}) {
  const projects = new Map(options.projects.map((p) => [p.id, p]));
  const patches: Array<{ id: string; set: object; unset: string[] }> = [];
  const orgSiteReads: string[] = [];
  const ctx = {
    organization: { id: ORG, slug: ORG },
    auth: {
      user: { id: "user", role: options.projectScope ? "member" : "owner" },
      permissions: options.projectScope
        ? { [PROJECT_SCOPE_KEY]: options.projectScope }
        : undefined,
      permissionsOrganizationId: ORG,
    },
    access: {
      getRole: () => (options.projectScope ? "member" : "owner"),
      check: async () => {},
    },
    storage: {
      kv: memoryKv(),
      virtualMcps: {
        findById: async (id: string) => projects.get(id) ?? null,
        patchMetadata: async (p: {
          id: string;
          organizationId: string;
          set: Record<string, unknown>;
          unset: string[];
        }) => {
          const project = projects.get(p.id);
          if (!project || project.organization_id !== p.organizationId) {
            return false;
          }
          patches.push({ id: p.id, set: p.set, unset: p.unset });
          const next = { ...project.metadata, ...p.set };
          for (const key of p.unset) delete next[key];
          project.metadata = next;
          return true;
        },
      },
      orgSites: {
        getByProject: async (projectId: string) => {
          orgSiteReads.push(projectId);
          const owner = options.sites?.[projectId];
          return owner
            ? { slug: SITE, organizationId: owner, projectId }
            : null;
        },
      },
    },
  } as unknown as StudioContext;
  return { ctx, projects, patches, orgSiteReads };
}

function project(
  id: string,
  metadata: Record<string, unknown> | null,
  organization = ORG,
): Project {
  return { id, organization_id: organization, metadata, connections: [] };
}

/** A fake repo whose every client call is recorded (method + args). */
function recordedRepo(files: Record<string, string>) {
  const git = fakeRepo(files);
  const calls: string[] = [];
  let opened = 0;
  const client = new Proxy(git.client, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(`${String(key)} ${JSON.stringify(args)}`);
        return value.apply(target, args);
      };
    },
  }) as RepoContentClient;
  const repoClientFor = async () => {
    opened++;
    return client;
  };
  return {
    git,
    calls,
    opened: () => opened,
    repoClientFor,
    /** Calls that read the schema (`isV8Schema`'s input). */
    schemaReads: () => calls.filter((c) => c.includes("schema.gen.json")),
  };
}

function mount(ctx: StudioContext, route: (app: Hono<Env>) => void): Hono<Env> {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("studioContext", ctx);
    await next();
  });
  route(app);
  return app;
}

describe("POST /blocks-major/:id", () => {
  const post = (app: Hono<Env>, id: string) =>
    app.request(`/blocks-major/${id}`, { method: "POST" });

  function setup(
    projects: Project[],
    files: Record<string, string>,
    extra: { sites?: Record<string, string>; projectScope?: string[] } = {},
  ) {
    const w = world({ projects, ...extra });
    const repo = recordedRepo(files);
    const app = mount(w.ctx, (a) =>
      a.route(
        "/blocks-major",
        createBlocksMajorRoutes({ repoClientFor: repo.repoClientFor }),
      ),
    );
    return { ...w, repo, app };
  }

  it("404s another org's project without reading anything", async () => {
    const { app, repo, patches } = setup(
      [project("p1", { repository: REPOSITORY }, "other-org")],
      { ".deco/schema.gen.json": SCHEMA_TEXT },
    );
    expect((await post(app, "p1")).status).toBe(404);
    expect(repo.opened()).toBe(0);
    expect(patches).toEqual([]);
  });

  it("404s a project outside a project-scoped role's allowlist", async () => {
    const { app, repo } = setup(
      [project("p1", { repository: REPOSITORY })],
      { ".deco/schema.gen.json": SCHEMA_TEXT },
      { projectScope: ["p2"] },
    );
    expect((await post(app, "p1")).status).toBe(404);
    expect(repo.opened()).toBe(0);
  });

  it("answers null for a project without a repository, writing nothing", async () => {
    const { app, repo, patches, orgSiteReads } = setup([project("p1", {})], {});
    const res = await post(app, "p1");
    expect(await res.json()).toEqual({ isV8: null, hostedSite: null });
    expect(repo.opened()).toBe(0);
    expect(patches).toEqual([]);
    expect(orgSiteReads).toEqual([]);
  });

  it("marks a v8 project and says whether it owns its site", async () => {
    const owned = setup(
      [project("p1", { repository: REPOSITORY })],
      { ".deco/schema.gen.json": SCHEMA_TEXT },
      { sites: { p1: ORG } },
    );
    expect(await (await post(owned.app, "p1")).json()).toEqual({
      isV8: true,
      hostedSite: true,
    });
    expect(owned.projects.get("p1")?.metadata).toEqual({
      repository: REPOSITORY,
      [BLOCKS_MAJOR_METADATA_KEY]: 8,
    });

    const unowned = setup(
      [project("p1", { repository: REPOSITORY })],
      { ".deco/schema.gen.json": SCHEMA_TEXT },
      { sites: { p1: "other-org" } },
    );
    expect(await (await post(unowned.app, "p1")).json()).toEqual({
      isV8: true,
      hostedSite: false,
    });
  });

  it("clears the marker of a project whose main is back on v7", async () => {
    const { app, projects, orgSiteReads } = setup(
      [project("p1", { repository: REPOSITORY, blocksMajor: 8 })],
      { ".deco/schema.gen.json": V7_SCHEMA },
      { sites: { p1: ORG } },
    );
    expect(await (await post(app, "p1")).json()).toEqual({
      isV8: false,
      hostedSite: null,
    });
    expect(projects.get("p1")?.metadata).toEqual({ repository: REPOSITORY });
    // v7: no ownership read either.
    expect(orgSiteReads).toEqual([]);
  });

  it("an unreadable main is an error the editor retries, never a v7 answer", async () => {
    const w = world({
      projects: [project("p1", { repository: REPOSITORY, blocksMajor: 8 })],
    });
    const app = mount(w.ctx, (a) =>
      a.route(
        "/blocks-major",
        createBlocksMajorRoutes({
          repoClientFor: async () => {
            throw new Error("GitHub is down");
          },
        }),
      ),
    );
    const res = await post(app, "p1");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "main_unreadable" });
    // The server's cached answer is left as it is.
    expect(w.patches).toEqual([]);
  });

  it("a repeat open on an unchanged main reads only its head", async () => {
    const { app, repo } = setup([project("p1", { repository: REPOSITORY })], {
      ".deco/schema.gen.json": V7_SCHEMA,
    });
    await post(app, "p1");
    const first = repo.calls.length;
    await post(app, "p1");
    const second = repo.calls.slice(first);
    expect(second.every((c) => /^(getDefaultBranch|getBranch) /.test(c))).toBe(
      true,
    );
  });
});

describe("hosted routes middleware", () => {
  let settings: ReturnType<typeof getSettings>;
  beforeAll(() => {
    settings = getSettings();
    setGlobalSettings({ ...settings, siteTokenSigningKey: "test-key" });
  });
  afterAll(() => setGlobalSettings(settings));

  function setup(
    metadata: Record<string, unknown>,
    files: Record<string, string>,
    sites: Record<string, string> = {},
  ) {
    const w = world({ projects: [project("p1", metadata)], sites });
    const repo = recordedRepo(files);
    const app = mount(w.ctx, (a) =>
      a.route(
        "/hosted",
        createHostedRoutes({ repoClientFor: repo.repoClientFor }),
      ),
    );
    return { ...w, repo, app };
  }

  const PATHS = [
    ["GET", "/hosted/p1/releases"],
    ["POST", "/hosted/p1/releases/current"],
    ["GET", "/hosted/p1/site-tokens"],
    ["POST", "/hosted/p1/site-tokens"],
  ] as const;

  it("404s a v7 project (main's schema), reading main once and no org_sites", async () => {
    const { app, repo, orgSiteReads, patches } = setup(
      { repository: REPOSITORY },
      { ".deco/schema.gen.json": V7_SCHEMA },
      { p1: ORG },
    );
    for (const [method, path] of PATHS) {
      expect((await app.request(path, { method })).status).toBe(404);
    }
    // One schema read for all four: the answer is reused for a minute.
    expect(repo.schemaReads().length).toBe(1);
    expect(orgSiteReads).toEqual([]);
    expect(patches).toEqual([]);
  });

  it("serves a v8 project whose marker is missing (main decides), writing it", async () => {
    const { app, projects } = setup(
      { repository: REPOSITORY },
      { ".deco/schema.gen.json": SCHEMA_TEXT },
      { p1: ORG },
    );
    const res = await app.request("/hosted/p1/site-tokens");
    expect(res.status).toBe(200);
    expect(projects.get("p1")?.metadata).toEqual({
      repository: REPOSITORY,
      [BLOCKS_MAJOR_METADATA_KEY]: 8,
    });
  });

  it("reuses main's answer while the marker agrees, reads again once it doesn't", async () => {
    const { app, projects, repo } = setup(
      { repository: REPOSITORY },
      { ".deco/schema.gen.json": V7_SCHEMA },
      { p1: ORG },
    );
    expect((await app.request("/hosted/p1/site-tokens")).status).toBe(404);
    // main upgrades to v8. Within the minute this pod reuses its answer...
    await repo.git.client.commitFiles({
      branch: "main",
      message: "v8",
      expectedHead: null,
      changes: [{ path: ".deco/schema.gen.json", content: SCHEMA_TEXT }],
    } as Parameters<RepoContentClient["commitFiles"]>[0]);
    expect((await app.request("/hosted/p1/site-tokens")).status).toBe(404);
    // ...until the editor's open (on any pod) writes the new answer to the
    // marker: a marker that disagrees is never reused over.
    projects.get("p1")!.metadata = {
      repository: REPOSITORY,
      [BLOCKS_MAJOR_METADATA_KEY]: 8,
    };
    expect((await app.request("/hosted/p1/site-tokens")).status).toBe(200);
  });

  it("404s a project whose stale marker says v8 while main is v7, clearing it", async () => {
    const { app, projects } = setup(
      { repository: REPOSITORY, blocksMajor: 8 },
      { ".deco/schema.gen.json": V7_SCHEMA },
      { p1: ORG },
    );
    expect((await app.request("/hosted/p1/releases")).status).toBe(404);
    expect(projects.get("p1")?.metadata).toEqual({ repository: REPOSITORY });
  });

  it("answers site_not_owned to a marked project that doesn't own its site", async () => {
    const { app, repo } = setup(
      { repository: REPOSITORY, blocksMajor: 8 },
      { ".deco/schema.gen.json": SCHEMA_TEXT },
      { p1: "other-org" },
    );
    for (const [method, path] of PATHS) {
      const res = await app.request(path, { method });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "site_not_owned" });
    }
    // Main's schema is read (once) to know it is a v8 site.
    expect(repo.schemaReads().length).toBe(1);
  });

  it("refuses a site token once main is back on v7, clearing the marker", async () => {
    const { app, projects, repo } = setup(
      { repository: REPOSITORY, blocksMajor: 8 },
      { ".deco/schema.gen.json": SCHEMA_TEXT },
      { p1: ORG },
    );
    expect((await app.request("/hosted/p1/site-tokens")).status).toBe(200);
    // main goes back to v7; a token is issued only on a fresh read of main.
    await repo.git.client.commitFiles({
      branch: "main",
      message: "back to v7",
      expectedHead: null,
      changes: [{ path: ".deco/schema.gen.json", content: V7_SCHEMA }],
    } as Parameters<RepoContentClient["commitFiles"]>[0]);
    const res = await app.request("/hosted/p1/site-tokens", {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect(projects.get("p1")?.metadata).toEqual({ repository: REPOSITORY });
  });
});

describe("decofile routes", () => {
  const PREVIEW = "https://acme.example.com";

  function setup(
    metadata: Record<string, unknown>,
    files: Record<string, string>,
    sites: Record<string, string> = {},
  ) {
    const w = world({
      projects: [
        project("p1", {
          repository: REPOSITORY,
          previewServerUrl: PREVIEW,
          ...metadata,
        }),
      ],
      sites,
    });
    const repo = recordedRepo(files);
    const app = mount(w.ctx, (a) =>
      a.route(
        "/decofile",
        createDecofileRoutes({ repoClientFor: repo.repoClientFor }),
      ),
    );
    return { ...w, repo, app };
  }

  const v8Files = {
    ".deco/schema.gen.json": SCHEMA_TEXT,
    ".deco/blocks/pages-home.json": '{"__resolveType":"page"}',
  };

  it("a v7 project reads main's schema once for every route, writes nothing, has no rpc", async () => {
    const { app, repo, patches } = setup(
      {},
      { ...v8Files, ".deco/schema.gen.json": V7_SCHEMA },
      { p1: ORG },
    );
    // v7's own reads still happen (the decofile from the branch).
    expect((await app.request("/decofile/p1/main")).status).toBe(200);
    expect(repo.opened()).toBeGreaterThan(0);
    await app.request("/decofile/p1/main", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ set: {}, delete: [] }),
    });
    await app.request("/decofile/p1/main/status");
    await app.request("/decofile/p1/main/publish", { method: "POST" });
    const rpc = await app.request("/decofile/p1/main/rpc", {
      method: "POST",
      body: "{}",
    });
    expect(rpc.status).toBe(404);
    expect(repo.schemaReads().length).toBe(1);
    expect(patches).toEqual([]);
  });

  it("an unmarked project whose main is v8 has the protocol (main decides)", async () => {
    const { app, projects } = setup({}, v8Files, { p1: ORG });
    const res = await app.request("/decofile/p1/main/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "describe" }),
    });
    expect(res.status).not.toBe(404);
    expect(projects.get("p1")?.metadata?.[BLOCKS_MAJOR_METADATA_KEY]).toBe(8);
  });

  it("rpc answers site_not_owned to a marked project that doesn't own its site", async () => {
    const { app, repo } = setup({ blocksMajor: 8 }, v8Files, {
      p1: "other-org",
    });
    const res = await app.request("/decofile/p1/main/rpc", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "site_not_owned" });
    expect(repo.schemaReads().length).toBe(1);
  });

  it("GET answers site_not_owned instead of the v7 decofile", async () => {
    const { app } = setup({ blocksMajor: 8 }, v8Files, { p1: "other-org" });
    const res = await app.request("/decofile/p1/main");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "site_not_owned" });
  });

  it("an unowned project whose main went back to v7 gets the v7 decofile", async () => {
    const { app, projects } = setup(
      { blocksMajor: 8 },
      { ...v8Files, ".deco/schema.gen.json": V7_SCHEMA },
      { p1: "other-org" },
    );
    const res = await app.request("/decofile/p1/main");
    expect(res.status).toBe(200);
    expect(
      projects.get("p1")?.metadata?.[BLOCKS_MAJOR_METADATA_KEY],
    ).toBeUndefined();
  });
});
