/**
 * Route-level tests of the Blocks v8 gates: the hosted routes' middleware and
 * the decofile routes, including the editor's read of main's schema (`rpc`
 * `schema.get`, which answers any site: there is no route of its own).
 * Storage is in memory and the repository is a fake that records every call,
 * so "a v7 project costs nothing" is asserted, not assumed.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BLOCKS_MAJOR_METADATA_KEY } from "@decocms/shared/blocks-major";
import { PROJECT_SCOPE_KEY } from "@decocms/shared/auth/project-scope";
import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import type { RepoContentClient } from "@/git-providers";
import { signDraftToken } from "@/decofile/draft-token";
import { createDraftStore } from "@/hosted/draft-store";
import {
  fakeRepo,
  memoryDeliveryStore,
  memoryKv,
  SCHEMA_TEXT,
} from "@/hosted/hosted-test-helpers";
import { getSettings, setGlobalSettings } from "@/settings";
import type { Env } from "../hono-env";
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
    ["POST", "/hosted/p1/releases/retry"],
    ["POST", `/hosted/p1/releases/${"a".repeat(40)}/reapply`],
    ["GET", `/hosted/p1/releases/${"a".repeat(40)}/reapply`],
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
    // One schema read for all of them: the answer is reused for a minute.
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

describe("main's schema for the editor (rpc schema.get, any site)", () => {
  const PREVIEW = "https://acme.example.com";
  const READ = JSON.stringify([
    { jsonrpc: "2.0", id: 1, method: "describe" },
    { jsonrpc: "2.0", id: 2, method: "schema.get" },
  ]);
  const read = (app: Hono<Env>, init: RequestInit = {}) =>
    app.request("/decofile/p1/main/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: READ,
      ...init,
    });

  function setup(
    metadata: Record<string, unknown> | null,
    files: Record<string, string>,
    options: {
      sites?: Record<string, string>;
      repoClientFor?: () => Promise<RepoContentClient>;
    } = {},
  ) {
    const w = world({
      projects: [project("p1", metadata)],
      sites: options.sites,
    });
    const repo = recordedRepo(files);
    const app = mount(w.ctx, (a) =>
      a.route(
        "/decofile",
        createDecofileRoutes({
          repoClientFor: options.repoClientFor ?? repo.repoClientFor,
        }),
      ),
    );
    return { ...w, repo, app };
  }

  const v7 = { repository: REPOSITORY, previewServerUrl: PREVIEW };

  it("a v7 site answers `schema: null`, read only, from one cached read of main", async () => {
    const { app, repo, patches } = setup(v7, {
      ".deco/schema.gen.json": V7_SCHEMA,
    });
    const res = await read(app);
    expect(res.status).toBe(200);
    const [describe, schema] = (await res.json()) as Array<{
      result: Record<string, unknown>;
    }>;
    expect(describe!.result).toMatchObject({
      readOnly: true,
      assets: null,
      kind: "git",
    });
    expect(schema!.result).toMatchObject({ schema: null });
    expect(repo.schemaReads().length).toBe(1);
    expect(patches).toEqual([]);
    // Opening it again on an unchanged main reads only its head.
    const before = repo.calls.length;
    await read(app);
    expect(
      repo.calls
        .slice(before)
        .every((c) => /^(getDefaultBranch|getBranch) /.test(c)),
    ).toBe(true);
  });

  it("a v7 site never takes a write through it", async () => {
    const { app, repo } = setup(v7, { ".deco/schema.gen.json": V7_SCHEMA });
    const res = await read(app, {
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "blocks.apply",
        params: { set: { x: {} } },
      }),
    });
    // The protocol's ReadOnly error.
    expect(
      ((await res.json()) as { error?: { code: number } }).error?.code,
    ).toBe(-32005);
    expect(repo.calls.some((c) => /^(commit|put|write)/i.test(c))).toBe(false);
  });

  it("a v8 main writes the server's marker and is told apart by its status", async () => {
    const { app, projects } = setup(
      v7,
      { ".deco/schema.gen.json": SCHEMA_TEXT },
      { sites: { p1: ORG } },
    );
    const res = await read(app);
    // No delivery bucket in tests: main is v8 but its editor can't open here.
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      code: "hosted_delivery_unconfigured",
    });
    expect(projects.get("p1")?.metadata?.[BLOCKS_MAJOR_METADATA_KEY]).toBe(8);
  });

  it("opening reads main fresh: a push within the minute is picked up at once", async () => {
    const { app, projects, repo } = setup(
      v7,
      { ".deco/schema.gen.json": SCHEMA_TEXT },
      { sites: { p1: ORG } },
    );
    expect((await read(app)).status).toBe(503);
    expect(projects.get("p1")?.metadata?.[BLOCKS_MAJOR_METADATA_KEY]).toBe(8);
    // main goes back to v7; a gate within the minute would reuse "v8"...
    await repo.git.client.commitFiles({
      branch: "main",
      message: "v7",
      expectedHead: null,
      changes: [{ path: ".deco/schema.gen.json", content: V7_SCHEMA }],
    } as Parameters<RepoContentClient["commitFiles"]>[0]);
    // ...but the editor's open reads main's head again.
    const res = await read(app);
    expect(res.status).toBe(200);
    expect(projects.get("p1")?.metadata).toEqual(v7);
  });

  it("a v8 main whose site another project owns answers site_not_owned", async () => {
    const { app } = setup(
      v7,
      { ".deco/schema.gen.json": SCHEMA_TEXT },
      { sites: { p1: "other-org" } },
    );
    const res = await read(app);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "site_not_owned" });
  });

  it("clears the marker of a project whose main is back on v7", async () => {
    const { app, projects } = setup(
      { ...v7, blocksMajor: 8 },
      { ".deco/schema.gen.json": V7_SCHEMA },
    );
    const res = await read(app);
    expect(res.status).toBe(200);
    expect(projects.get("p1")?.metadata).toEqual(v7);
  });

  it("a project without a repository says so, reading nothing", async () => {
    const { app, repo, patches } = setup({}, {});
    const res = await read(app);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "no_repository" });
    expect(repo.opened()).toBe(0);
    expect(patches).toEqual([]);
  });

  it("an unreadable main is an error the editor retries, never a v7 answer", async () => {
    const { app, patches } = setup(
      { ...v7, blocksMajor: 8 },
      {},
      {
        repoClientFor: async () => {
          throw new Error("GitHub is down");
        },
      },
    );
    const res = await read(app);
    expect(res.status).toBeGreaterThanOrEqual(500);
    // The server's cached answer is left as it is.
    expect(patches).toEqual([]);
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
    const delivery = memoryDeliveryStore();
    const app = mount(w.ctx, (a) =>
      a.route(
        "/decofile",
        createDecofileRoutes({
          repoClientFor: repo.repoClientFor,
          hostedDrafts: (kv) => createDraftStore({ kv, store: delivery.store }),
        }),
      ),
    );
    return { ...w, repo, app, delivery };
  }

  const v8Files = {
    ".deco/schema.gen.json": SCHEMA_TEXT,
    ".deco/blocks/pages-home.json": '{"__resolveType":"page"}',
  };

  it("an editor session's GET creates the empty draft and answers its pointer; the next GET answers the same one", async () => {
    const { app, delivery } = setup({ blocksMajor: 8 }, v8Files, { p1: ORG });
    const res = await app.request("/decofile/p1/main", {
      headers: { "x-deco-main-schema": "v8" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { draft: string; version: string };
    expect(body.draft).toMatch(/\/sites\/acme\/drafts\/[^/]+\.json$/);
    expect(body.version).toBeTruthy();
    const keys = [...delivery.objects.keys()];
    expect(keys).toHaveLength(1);
    expect(JSON.parse(delivery.objects.get(keys[0]!)!.text)).toEqual({
      set: {},
      delete: [],
    });
    expect(body.draft.endsWith(keys[0]!)).toBe(true);
    const again = await app.request("/decofile/p1/main", {
      headers: { "x-deco-main-schema": "v8" },
    });
    expect(await again.json()).toMatchObject(body);
    expect(delivery.log).toEqual([`put ${keys[0]}`]);
  });

  it("an anonymous (draft-token) GET creates no draft", async () => {
    const { app, ctx, delivery } = setup({ blocksMajor: 8 }, v8Files, {
      p1: ORG,
    });
    (ctx as unknown as { auth: unknown }).auth = { user: null };
    const token = signDraftToken({
      organizationId: ORG,
      virtualMcpId: "p1",
      branch: "main",
    });
    const res = await app.request(
      `/decofile/p1/main?token=${encodeURIComponent(token)}`,
    );
    // The runtime's bare decofile read: served, and nothing written.
    expect(res.status).toBe(200);
    expect(delivery.log).toEqual([]);
    expect(delivery.objects.size).toBe(0);
  });

  it("a v7 project reads main's schema once for every route, writes nothing, has no v8 rpc", async () => {
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
      headers: { "x-deco-main-schema": "v8" },
      body: "{}",
    });
    // An editor that read main as v8: main changed since.
    expect(rpc.status).toBe(409);
    expect(await rpc.json()).toMatchObject({ code: "main_schema_changed" });
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

  it("a v7 project whose main can't be read still gets its decofile (the unowned check is advisory)", async () => {
    const { app, repo } = setup(
      {},
      { ...v8Files, ".deco/schema.gen.json": V7_SCHEMA },
    );
    const getEntriesAtPaths = repo.git.client.getEntriesAtPaths;
    repo.git.client.getEntriesAtPaths = async (ref, paths) => {
      if (paths.some((path) => path.endsWith("schema.gen.json"))) {
        throw new Error("GitHub is down");
      }
      return getEntriesAtPaths.call(repo.git.client, ref, paths);
    };
    const res = await app.request("/decofile/p1/main");
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("decofile");
    // The real gate still fails closed.
    const rpc = await app.request("/decofile/p1/main/rpc", {
      method: "POST",
      body: "{}",
    });
    expect(rpc.status).toBeGreaterThanOrEqual(500);
  });

  describe("main unreadable on a site the project owns (no main-answer header)", () => {
    function unreadable(metadata: Record<string, unknown>) {
      const w = setup(
        metadata,
        { ...v8Files, ".deco/schema.gen.json": V7_SCHEMA },
        { p1: ORG },
      );
      const getEntriesAtPaths = w.repo.git.client.getEntriesAtPaths;
      w.repo.git.client.getEntriesAtPaths = async (ref, paths) => {
        if (paths.some((path) => path.endsWith("schema.gen.json"))) {
          throw new Error("GitHub is down");
        }
        return getEntriesAtPaths.call(w.repo.git.client, ref, paths);
      };
      return w;
    }

    it("a v7 project's read and Publish go on as on main (which never read main)", async () => {
      const { app, repo } = unreadable({});
      const read = await app.request("/decofile/p1/main");
      expect(read.status).toBe(200);
      expect(await read.json()).toHaveProperty("decofile");
      const publish = await app.request("/decofile/p1/feature/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(publish.status).toBeLessThan(500);
      expect(repo.calls.some((c) => c.startsWith("mergeBranches"))).toBe(true);
    });

    it("a project last found v8 fails instead of merging the v7 way", async () => {
      const { app, repo } = unreadable({ blocksMajor: 8 });
      const publish = await app.request("/decofile/p1/feature/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(publish.status).toBeGreaterThanOrEqual(500);
      expect(repo.calls.some((c) => c.startsWith("mergeBranches"))).toBe(false);
    });
  });

  describe("main changed mid-session (the editor says which main it acts on)", () => {
    const asV7 = { "x-deco-main-schema": "v7" };
    const asV8 = { "x-deco-main-schema": "v8" };

    it("a v7 editor reading a site whose main is now v8 is told, never served the hosted shape", async () => {
      const { app } = setup({}, v8Files, { p1: ORG });
      const res = await app.request("/decofile/p1/main", { headers: asV7 });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "main_schema_changed" });
    });

    it("a v8 editor reading a main back on v7 is told, never served the v7 decofile", async () => {
      const { app } = setup(
        { blocksMajor: 8 },
        { ...v8Files, ".deco/schema.gen.json": V7_SCHEMA },
        { p1: ORG },
      );
      const res = await app.request("/decofile/p1/main", { headers: asV8 });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "main_schema_changed" });
    });

    it("a v8 editor's Publish on a main back on v7 is refused, never merged", async () => {
      const { app, repo } = setup(
        { blocksMajor: 8 },
        { ...v8Files, ".deco/schema.gen.json": V7_SCHEMA },
        { p1: ORG },
      );
      const res = await app.request("/decofile/p1/feature/publish", {
        method: "POST",
        headers: { "content-type": "application/json", ...asV8 },
        body: JSON.stringify({ note: "x" }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "main_schema_changed" });
      expect(repo.calls.some((c) => c.startsWith("mergeBranches"))).toBe(false);
    });

    it("an editor whose answer still holds is served as before", async () => {
      const v7 = setup(
        {},
        { ...v8Files, ".deco/schema.gen.json": V7_SCHEMA },
        { p1: ORG },
      );
      const legacy = await v7.app.request("/decofile/p1/main", {
        headers: asV7,
      });
      expect(legacy.status).toBe(200);
      expect(await legacy.json()).toHaveProperty("decofile");
    });

    it("a v7 editor's reads cost at most one (cached) read of main", async () => {
      for (const sites of [{}, { p1: ORG }] as Array<Record<string, string>>) {
        const { app, repo } = setup(
          {},
          { ...v8Files, ".deco/schema.gen.json": V7_SCHEMA },
          sites,
        );
        for (let i = 0; i < 3; i++) {
          const res = await app.request("/decofile/p1/main", {
            headers: asV7,
          });
          expect(res.status).toBe(200);
        }
        expect(repo.schemaReads().length).toBeLessThanOrEqual(1);
      }
    });
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

  describe("a hosted v8 save (blocks.apply alone)", () => {
    const rpc = (app: Hono<Env>, body: unknown, headers = {}) =>
      app.request("/decofile/p1/main/rpc", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-deco-main-schema": "v8",
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const apply = (params: Record<string, unknown>, id = 1) => ({
      jsonrpc: "2.0",
      id,
      method: "blocks.apply",
      params,
    });

    it("makes no GitHub call: no repository client, no default branch, no schema", async () => {
      const { app, repo, delivery } = setup({ blocksMajor: 8 }, v8Files, {
        p1: ORG,
      });
      const res = await rpc(
        app,
        apply({
          set: { "pages-home": { __resolveType: "page", title: "draft" } },
          delete: ["Gone"],
          ifMatch: { "pages-home": null, Gone: null },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: { revision: string; versions: Record<string, unknown> };
      };
      expect(body.result?.versions).toEqual({
        "pages-home": expect.any(String),
        Gone: null,
      });
      expect(body.result?.revision).toMatch(/^~/);
      expect(repo.opened()).toBe(0);
      expect(repo.calls).toEqual([]);
      const [key] = await delivery.store.listKeys("sites/acme/drafts/");
      expect(JSON.parse(delivery.objects.get(key!)!.text)).toEqual({
        set: { "pages-home": { __resolveType: "page", title: "draft" } },
        delete: ["Gone"],
      });
      // A batch of saves is a save too.
      const batch = await rpc(app, [
        apply({ set: { a: { v: 1 } } }, 1),
        apply({ set: { b: { v: 2 } } }, 2),
      ]);
      expect(batch.status).toBe(200);
      expect(repo.calls).toEqual([]);
    });

    it("a guard the draft no longer meets is a Conflict, still with no GitHub call", async () => {
      const { app, repo } = setup({ blocksMajor: 8 }, v8Files, { p1: ORG });
      await rpc(app, apply({ set: { "pages-home": { v: 1 } } }));
      const res = await rpc(
        app,
        apply({
          set: { "pages-home": { v: 2 } },
          ifMatch: { "pages-home": null },
        }),
      );
      const body = (await res.json()) as { error?: { code: number } };
      // The protocol's Conflict.
      expect(body.error?.code).toBe(-32002);
      expect(repo.calls).toEqual([]);
    });

    it("reads go on through main with the draft on top", async () => {
      const { app, repo } = setup({ blocksMajor: 8 }, v8Files, { p1: ORG });
      await rpc(app, apply({ set: { New: { v: 1 } } }));
      expect(repo.calls).toEqual([]);
      const res = await rpc(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "blocks.list",
      });
      const body = (await res.json()) as {
        result: { blocks: Record<string, unknown> };
      };
      expect(Object.keys(body.result.blocks).sort()).toEqual([
        "New",
        "pages-home",
      ]);
      expect(repo.opened()).toBeGreaterThan(0);
    });

    it("an unmarked project, or a request without the editor's main answer, reads main first", async () => {
      const unmarked = setup({}, v8Files, { p1: ORG });
      await rpc(unmarked.app, apply({ set: { New: { v: 1 } } }));
      expect(unmarked.repo.opened()).toBeGreaterThan(0);
      const noHeader = setup({ blocksMajor: 8 }, v8Files, { p1: ORG });
      await noHeader.app.request("/decofile/p1/main/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(apply({ set: { New: { v: 1 } } })),
      });
      expect(noHeader.repo.opened()).toBeGreaterThan(0);
    });
  });
});
