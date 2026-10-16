/**
 * The site editor's GitHub backend for Blocks v8 sites on the hosted Deco
 * CMS: the content protocol over main with the project's CDN draft layered
 * on, and the publish that commits that draft to main and releases it.
 *
 *   POST /api/:org/decofile/:virtualMcpId/:branch/rpc        (session, v8 site)
 *   GET  /api/:org/decofile/:virtualMcpId/:branch            the draft pointer (session)
 *   POST /api/:org/decofile/:virtualMcpId/:branch/publish    commit + release
 *   /api/:org/hosted/:virtualMcpId/{releases,releases/:sha/reapply,releases/retry,site-tokens}
 *
 * The protocol's own black-box conformance suite runs against the endpoint,
 * with the repository on the local GitHub stub (see fixtures/fast-preview.ts)
 * and the delivery bucket on its stub (fixtures/delivery-stub-server.ts). The
 * cases below it cover what's specific to this backend: v8 detection, auth,
 * saves into the CDN draft (never git), v7 secret blocks left in a migrated
 * site, the `?__draft=` pointer the site revalidates with ETags, publish and
 * releases, site tokens, and the editor's v7/v8 detection: only a committed
 * schema with `"blocksMajor": 8` is a v8 site, in any org (no flag).
 */

import type { APIRequestContext } from "@playwright/test";
import type {
  BlocksApplyResult,
  BlocksListResult,
  DescribeResult,
} from "@decocms/blocks/protocol";
import { runConformance } from "@decocms/blocks/protocol/conformance";
import { isV8Schema } from "@decocms/shared/blocks-major";
import { publicKeyPemFromDer } from "@decocms/shared/secret-ciphertext";
import { signUpViaApi } from "../fixtures/auth-api";
import {
  createFastPreviewProject,
  type FastPreviewProject,
  inspectStubRepo,
  moveStubMain,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { startPreviewSite } from "../fixtures/preview-site";
import { expect, getE2EAppOrigin, newApiContext, test } from "../fixtures/test";

const DELIVERY_STUB_ORIGIN = `http://127.0.0.1:${process.env.DELIVERY_STUB_PORT ?? "4104"}`;

/** The delivery bucket's objects under a prefix, as the stub holds them. */
async function deliveryObjects(
  ctx: APIRequestContext,
  prefix: string,
): Promise<
  Record<string, { text: string; etag: string; cacheControl: string | null }>
> {
  const res = await ctx.get(
    `${DELIVERY_STUB_ORIGIN}/__admin/objects?prefix=${encodeURIComponent(prefix)}`,
  );
  expect(res.ok()).toBe(true);
  return (await res.json()) as Record<
    string,
    { text: string; etag: string; cacheControl: string | null }
  >;
}

const SECRET_BLOCK = "newsletter";
const SECRET_FIELD = "apiKey";

/**
 * A small v8 schema (deco-meta@1, `"blocksMajor": 8` as `deco schema` writes
 * it) with a block type that has a Secret field.
 */
const schema = {
  blocksMajor: 8,
  manifest: {
    blocks: {
      sections: {
        hero: { $ref: "#/definitions/aGVybw==" },
        [SECRET_BLOCK]: { $ref: "#/definitions/bmV3c2xldHRlcg==" },
      },
    },
  },
  schema: {
    definitions: {
      "aGVybw==": {
        type: "object",
        properties: { title: { type: "string" } },
      },
      "bmV3c2xldHRlcg==": {
        type: "object",
        properties: {
          listId: { type: "string" },
          [SECRET_FIELD]: { type: "string", format: "secret" },
        },
      },
    },
  },
};

async function generatePublicKeyPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  return publicKeyPemFromDer(
    new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
  );
}

const rpcPath = (p: FastPreviewProject, branch: string) =>
  `/api/${p.org}/decofile/${p.vmcpId}/${branch}/rpc`;

/** A fetch that goes through the Playwright context, so it carries the session. */
function contextFetch(ctx: APIRequestContext) {
  return async (request: Request): Promise<Response> => {
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : Buffer.from(await request.arrayBuffer());
    const res = await ctx.fetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      data: body,
      maxRedirects: 0,
    });
    // The context hands back the decoded body; Content-Encoding stays as sent.
    const headers = new Headers(res.headers());
    headers.delete("content-length");
    return new Response(new Uint8Array(await res.body()), {
      status: res.status(),
      headers,
    });
  };
}

async function rpc<T>(
  ctx: APIRequestContext,
  path: string,
  method: string,
  params: unknown = {},
): Promise<{ status: number; result?: T; error?: { code: number } }> {
  const res = await ctx.post(path, {
    data: { jsonrpc: "2.0", id: 1, method, params },
  });
  if (res.status() !== 200) return { status: res.status() };
  const body = (await res.json()) as { result?: T; error?: { code: number } };
  return { status: 200, ...body };
}

/** The session read, as the v8 editor makes it: its CDN draft pointer. */
async function draftPointer(
  ctx: APIRequestContext,
  project: FastPreviewProject,
  branch: string,
): Promise<{ draft: string | null; version: string | null }> {
  const res = await ctx.get(
    `/api/${project.org}/decofile/${project.vmcpId}/${branch}`,
  );
  expect(res.status()).toBe(200);
  return (await res.json()) as { draft: string | null; version: string | null };
}

/**
 * What opening the project does: the editor reads main's schema over the
 * content protocol (`schema.get`, any site; `schema: null` for a v7 one) and
 * decides with `isV8Schema`; the server's read refreshes the project's v8
 * marker on the way. The repository is seeded after the project is created,
 * so create's own check found nothing yet.
 */
async function refreshV8(
  ctx: APIRequestContext,
  project: FastPreviewProject,
): Promise<boolean> {
  const res = await ctx.post(rpcPath(project, "main"), {
    data: { jsonrpc: "2.0", id: 1, method: "schema.get" },
  });
  const body = (await res.json()) as {
    code?: string;
    result?: { schema: unknown };
  };
  // A v8 main whose site another project owns (the gate runs after main's
  // check), as the editor reads it.
  if (res.status() === 409) {
    expect(body.code).toBe("site_not_owned");
    return true;
  }
  expect(res.status()).toBe(200);
  return isV8Schema(body.result?.schema);
}

async function setUp(
  ctx: APIRequestContext,
  files: Record<string, string>,
): Promise<FastPreviewProject> {
  const user = await signUpViaApi(ctx);
  const owner = uniqueOwner();
  const project = await createFastPreviewProject(ctx, user.orgSlug, {
    owner,
    repo: "site",
    siteSlug: owner,
  });
  await seedStubRepo(ctx, {
    owner,
    repo: "site",
    defaultBranch: "main",
    branches: { main: { files } },
  });
  return project;
}

test.describe("content protocol on GitHub", () => {
  test("passes the protocol conformance suite", async ({ playwright }) => {
    test.setTimeout(10 * 60_000);
    const ctx = await newApiContext(playwright);
    try {
      const publicKey = await generatePublicKeyPem();
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify(schema),
        ".deco/secrets.pub": publicKey,
        ".deco/blocks/hero-home.json": '{"__resolveType":"hero"}\n',
      });
      expect(await refreshV8(ctx, project)).toBe(true);

      const report = await runConformance({
        endpoint: `${getE2EAppOrigin()}${rpcPath(project, "main")}`,
        fetch: contextFetch(ctx),
        secretField: { blockType: SECRET_BLOCK, field: SECRET_FIELD },
        secretsPublicKey: publicKey,
        // On main and untouched: the changes.* cases modify and restore it.
        baseEntry: { name: "hero-home" },
      });
      const failures = report.outcomes.filter((o) => o.status === "failed");
      expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
      expect(report.passed).toBeGreaterThan(20);
    } finally {
      await ctx.dispose();
    }
  });

  test("is on as soon as main's schema is v8, in any org, and needs a session", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const anon = await newApiContext(playwright);
    try {
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify(schema),
      });
      const path = rpcPath(project, "main");

      // Seeded after create: opening the project finds it is v8.
      expect(await refreshV8(ctx, project)).toBe(true);
      const described = await rpc<DescribeResult>(ctx, path, "describe");
      expect(described.result).toMatchObject({
        protocol: "deco-content",
        server: { name: "studio-github" },
        kind: "git",
        root: ".",
        assets: null,
        preview: { url: "https://site.example.com" },
      });

      expect((await rpc(anon, path, "describe")).status).toBe(401);
    } finally {
      await ctx.dispose();
      await anon.dispose();
    }
  });

  test("saves into the CDN draft, never into git", async ({ playwright }) => {
    const ctx = await newApiContext(playwright);
    try {
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify(schema),
        ".deco/blocks/hero-home.json": '{"__resolveType":"hero"}\n',
        ".deco/blocks/promo.json": '{"__resolveType":"hero","title":"Old"}\n',
      });
      expect(await refreshV8(ctx, project)).toBe(true);
      const path = rpcPath(project, "draft-1");
      const refsBefore = (await inspectStubRepo(ctx, project.owner, "site"))
        .refs;

      const before = await rpc<BlocksListResult>(ctx, path, "blocks.list");
      expect(before.result).toMatchObject({
        resolvedRef: "main",
        blocks: { "hero-home": { __resolveType: "hero" } },
      });
      // The protocol has no refs: `ref` is an unknown parameter.
      expect(
        (await rpc(ctx, path, "blocks.list", { ref: "main" })).error?.code,
      ).toBe(-32602);

      const hero = { __resolveType: "hero", title: "Hi" };
      const applied = await rpc<BlocksApplyResult>(ctx, path, "blocks.apply", {
        set: { "hero-home": hero },
        delete: ["promo"],
      });
      expect(applied.result?.revision).toMatch(/^[0-9a-f]{40}~/);

      // No branch, no commit: git is untouched.
      expect((await inspectStubRepo(ctx, project.owner, "site")).refs).toEqual(
        refsBefore,
      );
      const drafts = await deliveryObjects(
        ctx,
        `sites/${project.owner}/drafts/`,
      );
      // The draft the site reads is exactly { set, delete }; who changed
      // each name sits next to it, ids and times only.
      const draftKey = Object.keys(drafts).find((k) =>
        /\/[A-Za-z0-9_-]{22}\.json$/.test(k),
      )!;
      const draft = drafts[draftKey];
      expect(JSON.parse(draft!.text)).toEqual({
        set: { "hero-home": hero },
        delete: ["promo"],
      });
      const edits = drafts[draftKey.replace(/\.json$/, ".edits.json")];
      expect(JSON.parse(edits!.text)).toEqual({
        edits: {
          "hero-home": { userId: expect.any(String), at: expect.any(String) },
          promo: { userId: expect.any(String), at: expect.any(String) },
        },
      });
      expect(draft!.cacheControl).toBe("no-cache, max-age=0, must-revalidate");

      const after = await rpc<BlocksListResult>(ctx, path, "blocks.list");
      expect(after.result).toMatchObject({
        revision: applied.result?.revision,
        blocks: { "hero-home": hero },
      });
      expect(
        (after.result as { blocks?: Record<string, unknown> }).blocks,
      ).not.toHaveProperty("promo");
    } finally {
      await ctx.dispose();
    }
  });

  test("saves the v7 secret loader blocks a migrated site still has", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const loader = "website/loaders/secret.ts";
      // A v8 schema that still lists the v7 secret loader, which marks its
      // encrypted string `format: secret`.
      const migratedSchema = {
        blocksMajor: 8,
        manifest: {
          blocks: {
            loaders: { [loader]: { $ref: "#/definitions/c2VjcmV0" } },
            apps: { "site/apps/site.ts": { $ref: "#/definitions/c2l0ZQ==" } },
          },
        },
        schema: {
          definitions: {
            c2VjcmV0: {
              type: "object",
              properties: {
                name: { type: "string" },
                encrypted: { type: "string", format: "secret" },
              },
            },
            "c2l0ZQ==": {
              type: "object",
              properties: { apiKey: { $ref: "#/definitions/c2VjcmV0" } },
            },
          },
        },
      };
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify(migratedSchema),
        ".deco/blocks/site.json": '{"__resolveType":"site/apps/site.ts"}\n',
      });
      expect(await refreshV8(ctx, project)).toBe(true);

      const applied = await rpc<BlocksApplyResult>(
        ctx,
        rpcPath(project, "main"),
        "blocks.apply",
        {
          set: {
            site: {
              __resolveType: "site/apps/site.ts",
              apiKey: {
                __resolveType: loader,
                name: "API_KEY",
                encrypted: "0a1b2c3d",
              },
            },
          },
        },
      );
      expect(applied.error).toBeUndefined();
      expect(applied.result?.revision).toEqual(expect.any(String));
    } finally {
      await ctx.dispose();
    }
  });

  test("a v7 site's /rpc only answers main's schema (none) and never gets the v8 marker", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      // The same schema without `"blocksMajor": 8`: a v7 site.
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify({
          manifest: schema.manifest,
          schema: schema.schema,
        }),
        ".deco/blocks/hero-home.json": '{"__resolveType":"hero"}\n',
      });
      expect(await refreshV8(ctx, project)).toBe(false);
      const path = rpcPath(project, "main");
      const headBefore = (await inspectStubRepo(ctx, project.owner, "site"))
        .refs;

      // main isn't v8: the route only answers main's schema (none, read
      // only), which is how the editor tells; it never takes a write.
      const described = await rpc<{ readOnly: boolean; assets: unknown }>(
        ctx,
        path,
        "describe",
      );
      expect(described.result).toMatchObject({ readOnly: true, assets: null });
      const applied = await rpc(ctx, path, "blocks.apply", {
        set: { "hero-home": { __resolveType: "hero", title: "x" } },
      });
      expect(applied.error?.code).toBe(-32005);
      // An editor that read main as v8 is told main changed (and re-reads).
      const asV8 = await ctx.post(path, {
        headers: { "x-deco-main-schema": "v8" },
        data: { jsonrpc: "2.0", id: 1, method: "describe", params: {} },
      });
      expect(asV8.status()).toBe(409);
      expect(await asV8.json()).toMatchObject({ code: "main_schema_changed" });
      expect(
        (
          await ctx.get(`/api/${project.org}/hosted/${project.vmcpId}/releases`)
        ).status(),
      ).toBe(404);
      expect((await inspectStubRepo(ctx, project.owner, "site")).refs).toEqual(
        headBefore,
      );
    } finally {
      await ctx.dispose();
    }
  });

  test("a site whose main goes back to v7 is refused, then loses the protocol", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify(schema),
        ".deco/blocks/hero-home.json": '{"__resolveType":"hero"}\n',
      });
      expect(await refreshV8(ctx, project)).toBe(true);
      const path = rpcPath(project, "main");

      // main goes back to v7 behind Studio's back; the marker is now stale.
      await seedStubRepo(ctx, {
        owner: project.owner,
        repo: "site",
        defaultBranch: "main",
        branches: {
          main: {
            files: {
              ".deco/schema.gen.json": JSON.stringify({
                manifest: schema.manifest,
                schema: schema.schema,
              }),
              ".deco/blocks/hero-home.json": '{"__resolveType":"hero"}\n',
            },
          },
        },
      });
      const headBefore = (await inspectStubRepo(ctx, project.owner, "site"))
        .refs;

      // An open editor (acting on v8) saves within the gate's minute: the
      // storage checks main's schema itself, so nothing is saved or committed.
      const saved = await ctx.post(path, {
        headers: { "x-deco-main-schema": "v8" },
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "blocks.apply",
          params: {
            set: { "hero-home": { __resolveType: "hero", title: "x" } },
          },
        },
      });
      expect(saved.status()).toBe(200);
      expect(
        ((await saved.json()) as { error?: { code: number } }).error?.code,
      ).toBe(-32006);
      expect((await inspectStubRepo(ctx, project.owner, "site")).refs).toEqual(
        headBefore,
      );

      // Opening the project again clears the marker: no protocol (main's
      // schema only, read only), no hosted.
      expect(await refreshV8(ctx, project)).toBe(false);
      expect(
        (await rpc<{ readOnly: boolean }>(ctx, path, "describe")).result,
      ).toMatchObject({ readOnly: true });
      expect(
        (
          await ctx.get(`/api/${project.org}/hosted/${project.vmcpId}/releases`)
        ).status(),
      ).toBe(404);
    } finally {
      await ctx.dispose();
    }
  });

  test("a v8 site seeded after create gets a CMS thread right away", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const create = async (files: Record<string, string>) => {
        const owner = uniqueOwner();
        const project = await createFastPreviewProject(ctx, user.orgSlug, {
          owner,
          repo: "site",
          siteSlug: owner,
          // Off: only the v8 check can make a new thread `cms`.
          fastPreview: false,
        });
        await seedStubRepo(ctx, {
          owner,
          repo: "site",
          defaultBranch: "main",
          branches: { main: { files } },
        });
        return project;
      };
      const runtimeOfNewThread = async (project: FastPreviewProject) => {
        // No refresh first: the thread is created as the project opens.
        const { item } = await callSelfMcpTool<{
          item: { metadata?: { runtime?: string } };
        }>(ctx, user.orgSlug, "COLLECTION_THREADS_CREATE", {
          data: { virtual_mcp_id: project.vmcpId },
        });
        return item.metadata?.runtime;
      };

      const v8 = await create({
        ".deco/schema.gen.json": JSON.stringify(schema),
      });
      expect(await runtimeOfNewThread(v8)).toBe("cms");

      const v7 = await create({
        ".deco/schema.gen.json": JSON.stringify({
          manifest: schema.manifest,
          schema: schema.schema,
        }),
      });
      expect(await runtimeOfNewThread(v7)).toBe("sandbox");
    } finally {
      await ctx.dispose();
    }
  });

  test("a v8 site this project doesn't own says so instead of failing", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const owner = uniqueOwner();
      // No siteSlug: the project isn't linked to a site in org_sites.
      const project = await createFastPreviewProject(ctx, user.orgSlug, {
        owner,
        repo: "site",
      });
      await seedStubRepo(ctx, {
        owner,
        repo: "site",
        defaultBranch: "main",
        branches: {
          main: { files: { ".deco/schema.gen.json": JSON.stringify(schema) } },
        },
      });
      // Main is v8 (the gate runs after main's check), but the site is
      // another project's: the editor reads it as v8 and shows why.
      const read = await ctx.post(rpcPath(project, "main"), {
        data: { jsonrpc: "2.0", id: 1, method: "schema.get" },
      });
      expect(read.status()).toBe(409);
      expect(await read.json()).toMatchObject({ code: "site_not_owned" });

      const described = await ctx.post(rpcPath(project, "main"), {
        data: { jsonrpc: "2.0", id: 1, method: "describe", params: {} },
      });
      expect(described.status()).toBe(409);
      expect(await described.json()).toMatchObject({ code: "site_not_owned" });
      const releases = await ctx.get(
        `/api/${project.org}/hosted/${project.vmcpId}/releases`,
      );
      expect(releases.status()).toBe(409);
    } finally {
      await ctx.dispose();
    }
  });

  test("the draft pointer names the CDN draft, which the site revalidates", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const site = await playwright.request.newContext();
    try {
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify(schema),
        ".deco/blocks/hero-home.json": '{"__resolveType":"hero"}\n',
      });
      expect(await refreshV8(ctx, project)).toBe(true);

      // Nothing saved yet: no draft, so no pointer.
      expect(await draftPointer(ctx, project, "draft-1")).toEqual({
        draft: null,
        version: null,
      });

      const hero = { __resolveType: "hero", title: "Summer" };
      await rpc<BlocksApplyResult>(
        ctx,
        rpcPath(project, "draft-1"),
        "blocks.apply",
        {
          set: { "hero-home": hero },
        },
      );
      const pointer = await draftPointer(ctx, project, "draft-1");
      const host = new URL(DELIVERY_STUB_ORIGIN).host;
      expect(pointer.draft).toMatch(
        new RegExp(
          `^${host}/sites/${project.owner}/drafts/[A-Za-z0-9_-]{22}\\.json$`,
        ),
      );
      expect(pointer.version).toEqual(expect.any(String));

      // What the site's SDK fetches: the draft, then 304 while it is unchanged.
      const url = `http://${pointer.draft}?v=${pointer.version}`;
      const first = await site.get(url);
      expect(first.status()).toBe(200);
      expect(await first.json()).toEqual({
        set: { "hero-home": hero },
        delete: [],
      });
      const etag = first.headers()["etag"]!;
      const again = await site.get(url, { headers: { "If-None-Match": etag } });
      expect(again.status()).toBe(304);

      // Another save is a new ETag, so a new pointer version.
      await rpc(ctx, rpcPath(project, "draft-1"), "blocks.apply", {
        set: { "hero-home": { ...hero, title: "Winter" } },
      });
      const next = await draftPointer(ctx, project, "draft-1");
      expect(next.draft).toBe(pointer.draft);
      expect(next.version).not.toBe(pointer.version);
      expect(
        (await site.get(url, { headers: { "If-None-Match": etag } })).status(),
      ).toBe(200);
    } finally {
      await ctx.dispose();
      await site.dispose();
    }
  });

  test("Publish commits the draft to main and releases it; Reapply release rolls forward to an earlier release's content; Try again releases main's head", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify(schema),
        ".deco/blocks/hero-home.json": '{"__resolveType":"hero"}\n',
      });
      expect(await refreshV8(ctx, project)).toBe(true);
      const decofile = `/api/${project.org}/decofile/${project.vmcpId}`;
      const hosted = `/api/${project.org}/hosted/${project.vmcpId}`;
      const site = project.owner;

      const publish = async (title: string) => {
        await rpc(ctx, rpcPath(project, "draft-1"), "blocks.apply", {
          set: { "hero-home": { __resolveType: "hero", title } },
        });
        const res = await ctx.post(`${decofile}/draft-1/publish`, {
          data: { note: `Publish ${title}` },
        });
        expect(res.status()).toBe(200);
        return (await res.json()) as {
          result: string;
          sha: string;
          release: string;
        };
      };

      const first = await publish("One");
      expect(first).toMatchObject({ result: "merged", release: "current" });
      const repo = await inspectStubRepo(ctx, project.owner, "site");
      expect(repo.refs.main).toBe(first.sha);
      expect(repo.branches.main!.files[".deco/blocks/hero-home.json"]).toBe(
        `${JSON.stringify({ __resolveType: "hero", title: "One" }, null, 2)}\n`,
      );
      const objects = await deliveryObjects(ctx, `sites/${site}/`);
      const revision = objects[`sites/${site}/revisions/${first.sha}.json`]!;
      expect(JSON.parse(revision.text)).toMatchObject({
        revision: first.sha,
        schemaHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        blocks: { "hero-home": { __resolveType: "hero", title: "One" } },
      });
      expect(revision.cacheControl).toBe("public, max-age=31536000, immutable");
      const latest = JSON.parse(objects[`sites/${site}/latest.json`]!.text);
      expect(Object.keys(latest).sort()).toEqual([
        "publishedAt",
        "revision",
        "schemaHash",
      ]);
      expect(latest.revision).toBe(first.sha);
      // The draft is gone; the next edit starts a new one.
      expect(Object.keys(objects).some((k) => k.includes("/drafts/"))).toBe(
        false,
      );

      const second = await publish("Two");
      let releases = await (await ctx.get(`${hosted}/releases`)).json();
      expect(releases).toMatchObject({ current: { revision: second.sha } });
      const publishedAt = (): Promise<string> =>
        deliveryObjects(ctx, `sites/${site}/latest.json`).then(
          (o) => JSON.parse(o[`sites/${site}/latest.json`]!.text).publishedAt,
        );
      const secondAt = await publishedAt();
      expect(
        releases.commits.map((c: { sha: string; hasRelease: boolean }) => [
          c.sha,
          c.hasRelease,
        ]),
      ).toEqual([
        [second.sha, true],
        [first.sha, true],
        [expect.any(String), false],
      ]);

      // Before the dialog: same schema, so no "how to go back" line.
      const check = await ctx.get(`${hosted}/releases/${first.sha}/reapply`);
      expect(check.status()).toBe(200);
      expect(await check.json()).toEqual({ schemaChanged: false });

      // Reapply the first version: a NEW version (a commit on main) with its
      // content, released as the latest; history stays linear.
      const reapplied = await ctx.post(
        `${hosted}/releases/${first.sha}/reapply`,
      );
      expect(reapplied.status()).toBe(200);
      const third = (await reapplied.json()) as {
        result: string;
        sha: string;
        release: string;
        schemaChanged: boolean;
      };
      expect(third).toMatchObject({
        result: "merged",
        release: "current",
        schemaChanged: false,
      });
      expect(third.sha).not.toBe(first.sha);
      const afterReapply = await inspectStubRepo(ctx, project.owner, "site");
      expect(afterReapply.refs.main).toBe(third.sha);
      expect(
        afterReapply.branches.main!.files[".deco/blocks/hero-home.json"],
      ).toBe(
        `${JSON.stringify({ __resolveType: "hero", title: "One" }, null, 2)}\n`,
      );
      // The delivery store holds exactly the first version's content.
      const stored = await deliveryObjects(ctx, `sites/${site}/`);
      const blocksOf = (sha: string) =>
        JSON.parse(stored[`sites/${site}/revisions/${sha}.json`]!.text).blocks;
      expect(blocksOf(third.sha)).toEqual(blocksOf(first.sha));
      const reappliedAt = await publishedAt();
      expect(Date.parse(reappliedAt)).toBeGreaterThan(Date.parse(secondAt));
      expect(
        JSON.parse(stored[`sites/${site}/latest.json`]!.text).revision,
      ).toBe(third.sha);
      releases = await (await ctx.get(`${hosted}/releases`)).json();
      expect(releases).toMatchObject({ current: { revision: third.sha } });
      expect(releases.serving).toBeUndefined();
      expect(releases.commits[0]).toMatchObject({
        sha: third.sha,
        message: "Reapply: Publish One",
        hasRelease: true,
        reapplyOf: { sha: first.sha },
      });
      // Reapplying what main already holds commits nothing.
      const again = await ctx.post(`${hosted}/releases/${first.sha}/reapply`);
      expect(await again.json()).toEqual({ result: "up-to-date" });
      // A commit without a companion release can't be reapplied.
      const initial = releases.commits.at(-1).sha as string;
      expect(
        (await ctx.post(`${hosted}/releases/${initial}/reapply`)).status(),
      ).toBe(404);
      expect(
        (await ctx.get(`${hosted}/releases/${initial}/reapply`)).status(),
      ).toBe(404);
      // The pointer flip is gone: there is no releases/current any more.
      expect(
        (
          await ctx.post(`${hosted}/releases/current`, {
            data: { sha: second.sha },
          })
        ).status(),
      ).toBe(404);

      // A Publish that commits nothing leaves latest.json alone.
      await rpc(ctx, rpcPath(project, "draft-1"), "blocks.apply", {
        set: { "hero-home": { __resolveType: "hero", title: "One" } },
      });
      const noop = await ctx.post(`${decofile}/draft-1/publish`, {
        data: { note: "" },
      });
      expect(await noop.json()).toEqual({ result: "up-to-date" });
      expect(await publishedAt()).toBe(reappliedAt);

      // A later edit sits on the restored content.
      const fourth = await publish("Four");
      expect(fourth).toMatchObject({ result: "merged", release: "current" });
      const afterEdit = await inspectStubRepo(ctx, project.owner, "site");
      expect(afterEdit.refs.main).toBe(fourth.sha);
      expect(
        afterEdit.branches.main!.files[".deco/blocks/hero-home.json"],
      ).toBe(
        `${JSON.stringify({ __resolveType: "hero", title: "Four" }, null, 2)}\n`,
      );

      // Publish's "Try again" (releases/retry) releases main's head: the
      // newest Publish, never an older one.
      const retried = await ctx.post(`${hosted}/releases/retry`);
      expect(retried.status()).toBe(200);
      expect(await retried.json()).toMatchObject({
        current: { revision: fourth.sha },
      });
      releases = await (await ctx.get(`${hosted}/releases`)).json();
      expect(releases).toMatchObject({ current: { revision: fourth.sha } });
      expect(releases.commits.map((c: { sha: string }) => c.sha)).toEqual([
        fourth.sha,
        third.sha,
        second.sha,
        first.sha,
        initial,
      ]);
    } finally {
      await ctx.dispose();
    }
  });

  test("issues site tokens, with no limit", async ({ playwright }) => {
    const ctx = await newApiContext(playwright);
    try {
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify(schema),
      });
      expect(await refreshV8(ctx, project)).toBe(true);
      const tokens = `/api/${project.org}/hosted/${project.vmcpId}/site-tokens`;

      const issued = await ctx.post(tokens);
      expect(issued.status()).toBe(200);
      const { token, record } = (await issued.json()) as {
        token: string;
        record: { kid: string };
      };
      const payload = JSON.parse(
        Buffer.from(token.split(".")[1]!, "base64url").toString(),
      );
      expect(payload).toEqual({
        site: project.owner,
        kid: record.kid,
        iat: expect.any(Number),
      });
      expect((await ctx.post(tokens)).status()).toBe(200);
      expect((await ctx.post(tokens)).status()).toBe(200);
      const listed = await (await ctx.get(tokens)).json();
      expect(listed.site).toBe(project.owner);
      expect(listed.tokens).toHaveLength(3);
      expect(JSON.stringify(listed)).not.toContain(token);
    } finally {
      await ctx.dispose();
    }
  });

  test("a project's site can't be changed, so hosted keys stay on it", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify(schema),
      });
      expect(await refreshV8(ctx, project)).toBe(true);
      // Hosted ownership is the `org_sites` link made at creation, never
      // `metadata.siteSlug`, and the API refuses to rewrite the slug.
      await expect(
        callSelfMcpTool(ctx, project.org, "COLLECTION_VIRTUAL_MCP_UPDATE", {
          id: project.vmcpId,
          data: { metadata: { siteSlug: uniqueOwner() } },
        }),
      ).rejects.toThrow(/site id can't change/);
      const hosted = `/api/${project.org}/hosted/${project.vmcpId}`;
      const listed = await (await ctx.get(`${hosted}/site-tokens`)).json();
      expect((listed as { site: string }).site).toBe(project.owner);
    } finally {
      await ctx.dispose();
    }
  });

  test("creating a project links its siteSlug, never another org's", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const other = await newApiContext(playwright);
    try {
      // `setUp` creates the project with `siteSlug: owner`; nothing else
      // links it, so site tokens working proves the link.
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify(schema),
      });
      expect(await refreshV8(ctx, project)).toBe(true);
      const tokens = `/api/${project.org}/hosted/${project.vmcpId}/site-tokens`;
      expect((await ctx.post(tokens)).status()).toBe(200);

      // Another org naming the same site gets no link and no hosted features.
      const user = await signUpViaApi(other);
      const copy = await createFastPreviewProject(other, user.orgSlug, {
        owner: project.owner,
        repo: "site",
        siteSlug: project.owner,
      });
      // Its main is v8, so it is a v8 project, but the site isn't its own.
      expect(await refreshV8(other, copy)).toBe(true);
      const hosted = `/api/${copy.org}/hosted/${copy.vmcpId}`;
      const minted = await other.post(`${hosted}/site-tokens`);
      expect(minted.status()).toBe(409);
      expect(await minted.json()).toMatchObject({ code: "site_not_owned" });
      // And the first org keeps it.
      expect(
        ((await (await ctx.get(tokens)).json()) as { site: string }).site,
      ).toBe(project.owner);
    } finally {
      await ctx.dispose();
      await other.dispose();
    }
  });
});

/** A v7 site's `meta.gen.json`, as the classic editor reads it. */
const v7Meta = {
  manifest: {
    blocks: {
      pages: { "website/pages/Page.tsx": { $ref: "#/definitions/Page" } },
      sections: {
        "site/sections/Hero.tsx": { $ref: "#/definitions/Hero" },
      },
    },
  },
  schema: {
    definitions: {
      Page: { type: "object", properties: {} },
      Hero: {
        type: "object",
        title: "Hero",
        properties: { title: { type: "string", title: "Title" } },
      },
    },
  },
};

const homePage = JSON.stringify({
  __resolveType: "website/pages/Page.tsx",
  name: "Home",
  path: "/",
  sections: [{ __resolveType: "site/sections/Hero.tsx", title: "Hello" }],
});

/** A Fast Preview project in the signed-in user's org (no flag needed). */
async function openEditor(
  api: APIRequestContext,
  orgSlug: string,
  previewServerUrl: string,
  files: Record<string, string>,
  /** `siteSlug: null`: the project isn't linked to a site (doesn't own it). */
  options: { siteSlug?: null } = {},
): Promise<{ url: string; project: FastPreviewProject }> {
  const owner = uniqueOwner();
  const project = await createFastPreviewProject(api, orgSlug, {
    owner,
    repo: "site",
    // The header's PR lookup dials this; a closed port fails fast.
    connectionUrl: "http://127.0.0.1:1/unused",
    previewServerUrl,
    ...(options.siteSlug === null ? {} : { siteSlug: owner }),
  });
  await seedStubRepo(api, {
    owner,
    repo: "site",
    defaultBranch: "main",
    branches: { main: { files } },
  });
  const { item: thread } = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    { data: { virtual_mcp_id: project.vmcpId, branch: "main" } },
  );
  return {
    project,
    url: `/${orgSlug}/projects/${project.vmcpId}/site-editor?thread=${thread.id}&sidepanel=false`,
  };
}

test.describe("v7/v8 detection from the schema, in any org", () => {
  test.setTimeout(120_000);

  for (const [name, file, meta] of [
    ["a v7 meta.gen.json", ".deco/meta.gen.json", v7Meta],
    [
      "a meta.gen.json that names another major",
      ".deco/meta.gen.json",
      { ...v7Meta, blocksMajor: 7 },
    ],
  ] as const) {
    test(`${name} without "blocksMajor": 8 stays on the v7 editor`, async ({
      authedPage: { page, orgSlug },
    }) => {
      const preview = await startPreviewSite();
      try {
        const { url } = await openEditor(page.request, orgSlug, preview.url, {
          [file]: JSON.stringify(meta),
          ".deco/blocks/home.json": homePage,
        });
        // The editor decides from main's schema (its one `schema.get`),
        // never from the project's marker; a v7 main gets no v8 schema and
        // never reaches the rest of the protocol.
        const mainReads: number[] = [];
        const rpcCalls: string[] = [];
        page.on("response", async (response) => {
          const path = new URL(response.url()).pathname;
          if (!/\/decofile\/.+\/rpc$/.test(path)) return;
          const method = (
            response.request().postDataJSON() as { method?: string } | null
          )?.method;
          if (method === "schema.get" && path.endsWith("/main/rpc")) {
            mainReads.push(response.status());
          } else {
            rpcCalls.push(`${path} ${method}`);
          }
        });
        await page.goto(url);
        // The classic editor (the org's `new_blocks_editor` is off): v8
        // sites always get the new one, so this is the v7 path.
        const blocks = page.getByTestId("blocks-panel");
        await expect(
          blocks.getByPlaceholder("Page name", { exact: true }),
        ).toHaveValue("Home", { timeout: 60_000 });
        await expect(page.getByTestId("content-version-badge")).toHaveCount(0);
        expect(mainReads).toContain(200);
        expect(rpcCalls).toEqual([]);
      } finally {
        await preview.close();
      }
    });
  }

  test("a v7 site whose main can't be read still gets the v7 editor, as on main", async ({
    authedPage: { page, orgSlug },
  }) => {
    const preview = await startPreviewSite();
    try {
      const { url } = await openEditor(page.request, orgSlug, preview.url, {
        ".deco/meta.gen.json": JSON.stringify(v7Meta),
        ".deco/blocks/home.json": homePage,
      });
      // Main's schema can't be read (a GitHub outage, a revoked token): a
      // site never found v8 behaves as on main, never an indefinite wait.
      let mainReads = 0;
      // (The editor's read of main's schema: `schema.get` on main's rpc.)
      await page.route(/\/api\/[^/]+\/decofile\/[^/]+\/main\/rpc$/, (route) => {
        mainReads++;
        return route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ error: "GitHub is down" }),
        });
      });
      await page.goto(url);
      const blocks = page.getByTestId("blocks-panel");
      await expect(
        blocks.getByPlaceholder("Page name", { exact: true }),
      ).toHaveValue("Home", { timeout: 60_000 });
      await expect(page.getByTestId("content-version-badge")).toHaveCount(0);
      await expect(page.getByText(/Trying again/)).toHaveCount(0);
      expect(mainReads).toBeGreaterThan(0);
    } finally {
      await preview.close();
    }
  });

  test("a v8 site another project owns shows where it is edited", async ({
    authedPage: { page, orgSlug },
  }) => {
    const preview = await startPreviewSite();
    try {
      const { url } = await openEditor(
        page.request,
        orgSlug,
        preview.url,
        {
          ".deco/schema.gen.json": JSON.stringify({
            ...v7Meta,
            blocksMajor: 8,
          }),
          ".deco/blocks/home.json": homePage,
        },
        { siteSlug: null },
      );
      await page.goto(url);
      await expect(
        page.getByText("This site is edited from another project"),
      ).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("site-not-owned-projects")).toBeVisible();
    } finally {
      await preview.close();
    }
  });

  test('a schema with "blocksMajor": 8 is a v8 site', async ({
    authedPage: { page, orgSlug },
  }) => {
    const preview = await startPreviewSite();
    try {
      const { url } = await openEditor(page.request, orgSlug, preview.url, {
        ".deco/schema.gen.json": JSON.stringify({
          ...v7Meta,
          blocksMajor: 8,
        }),
        ".deco/blocks/home.json": homePage,
      });
      // Seeded after create: opening the project reads main's schema and
      // waits for that answer (never the marker) before picking a backend.
      await page.goto(url);
      await expect(page.getByTestId("content-version-badge")).toHaveText("v8", {
        timeout: 60_000,
      });
    } finally {
      await preview.close();
    }
  });

  test("a v7 site's decofile read and save still mint draft tokens", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const anon = await newApiContext(playwright);
    try {
      const project = await setUp(ctx, {
        ".deco/meta.gen.json": JSON.stringify(v7Meta),
        ".deco/blocks/home.json": homePage,
      });
      expect(await refreshV8(ctx, project)).toBe(false);
      const url = `/api/${project.org}/decofile/${project.vmcpId}/draft-1`;

      const saved = await ctx.patch(url, {
        data: { set: { promo: { __resolveType: "site/sections/Hero.tsx" } } },
      });
      expect(saved.status()).toBe(200);
      const { token } = (await saved.json()) as { token: string };
      expect(token).toEqual(expect.any(String));

      const read = await ctx.get(url);
      expect(read.status()).toBe(200);
      expect(((await read.json()) as { token?: string }).token).toEqual(
        expect.any(String),
      );

      // The draft link the site pulls still answers the whole decofile.
      const pulled = await anon.get(
        `${url}?token=${encodeURIComponent(token)}`,
      );
      expect(pulled.status()).toBe(200);
      const decofile = (await pulled.json()) as Record<string, unknown>;
      expect(decofile.promo).toEqual({
        __resolveType: "site/sections/Hero.tsx",
      });
    } finally {
      await ctx.dispose();
      await anon.dispose();
    }
  });
});

test.describe("v8 editor: every content change refreshes the editor and the preview", () => {
  test.setTimeout(180_000);

  test("a change discarded in Review & Publish puts main's value back in the form and reloads the preview", async ({
    authedPage: { page, orgSlug },
  }) => {
    const preview = await startPreviewSite();
    try {
      const { url, project } = await openEditor(
        page.request,
        orgSlug,
        preview.url,
        {
          ".deco/schema.gen.json": JSON.stringify({
            ...v7Meta,
            blocksMajor: 8,
          }),
          ".deco/blocks/home.json": homePage,
        },
      );
      const rpcMethods: string[] = [];
      // The v8 change list, its sides and its discards are the content
      // protocol's (changes.*): no git route is asked about them.
      const gitRoutes: string[] = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (/\/git\/(status|diff|discard)$/.test(path)) gitRoutes.push(path);
        if (!/\/decofile\/.+\/rpc$/.test(path)) return;
        const body = request.postDataJSON() as
          | { method?: string }
          | Array<{ method?: string }>
          | null;
        for (const call of Array.isArray(body) ? body : [body]) {
          if (call?.method) rpcMethods.push(call.method);
        }
      });
      const frameUrls: string[] = [];
      page.on("framenavigated", (frame) => {
        if (frame.url().startsWith(preview.url)) frameUrls.push(frame.url());
      });

      await page.goto(url);
      await expect(page.getByTestId("content-version-badge")).toHaveText("v8", {
        timeout: 60_000,
      });
      const blocks = page.getByTestId("blocks-panel");
      await blocks.getByText("Hero", { exact: true }).first().click();
      const title = page.getByLabel("Title", { exact: true });
      await expect(title).toHaveValue("Hello", { timeout: 30_000 });

      // The edit lands in the CDN draft and the preview shows that draft.
      await title.fill("Discard me");
      const drafts = `sites/${project.owner}/drafts/`;
      await expect
        .poll(
          async () =>
            Object.values(await deliveryObjects(page.request, drafts)).some(
              (o) => o.text.includes("Discard me"),
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      // `<draft>@<etag>`: the frame renders the draft (not `__draft=off`).
      const showsDraft = (u: string) => /__draft=[^&]*(%40|@)/.test(u);
      await expect
        .poll(() => frameUrls.some(showsDraft), { timeout: 30_000 })
        .toBe(true);
      const editedFrame = frameUrls.filter(showsDraft).at(-1)!;

      await page.getByRole("button", { name: "Review & Publish" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.locator('[data-publish-state="ready"]')).toBeVisible({
        timeout: 60_000,
      });
      const shown = frameUrls.length;
      const appliesBefore = rpcMethods.filter(
        (m) => m === "blocks.apply",
      ).length;
      await dialog.getByRole("button", { name: "Discard" }).first().click();
      await dialog
        .getByRole("button", { name: "Discard", exact: true })
        .click();
      // The preview shows the change being written and reloaded.
      await expect(page.locator(".animate-preview-ramp")).toBeAttached({
        timeout: 5_000,
      });
      await expect(dialog.getByText("Everything is published")).toBeVisible({
        timeout: 30_000,
      });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);

      // The discard removed the block from the draft through the protocol
      // (no main sync: nothing of main's is written through blocks.apply).
      expect(rpcMethods.filter((m) => m === "changes.discard")).toHaveLength(1);
      expect(rpcMethods).toContain("changes.list");
      expect(rpcMethods).toContain("changes.get");
      expect(gitRoutes).toEqual([]);
      expect(rpcMethods.filter((m) => m === "blocks.apply").length).toBe(
        appliesBefore,
      );
      // The open form shows main's value again, with no wait for a poll.
      await expect(title).toHaveValue("Hello", { timeout: 10_000 });
      // The preview left the discarded draft, and its indicator cleared.
      await expect
        .poll(() => frameUrls.slice(shown).length, { timeout: 15_000 })
        .toBeGreaterThan(0);
      expect(frameUrls.at(-1)).not.toBe(editedFrame);
      await expect(page.locator(".animate-preview-ramp")).toHaveCount(0, {
        timeout: 20_000,
      });
      await expect(page.getByRole("button", { name: /Saving/ })).toHaveCount(0);
      // Nothing is left to publish, and the draft holds no copy of main.
      const left = Object.values(await deliveryObjects(page.request, drafts));
      expect(left.some((o) => o.text.includes("Discard me"))).toBe(false);
    } finally {
      await preview.close();
    }
  });

  test("a discard removes the block from the draft: main's current value shows, and follows main when it moves again", async ({
    authedPage: { page, orgSlug },
  }) => {
    const preview = await startPreviewSite();
    try {
      const schema = JSON.stringify({ ...v7Meta, blocksMajor: 8 });
      const { url, project } = await openEditor(
        page.request,
        orgSlug,
        preview.url,
        {
          ".deco/schema.gen.json": schema,
          ".deco/blocks/home.json": homePage,
        },
      );
      await page.goto(url);
      await expect(page.getByTestId("content-version-badge")).toHaveText("v8", {
        timeout: 60_000,
      });
      const blocks = page.getByTestId("blocks-panel");
      await blocks.getByText("Hero", { exact: true }).first().click();
      const title = page.getByLabel("Title", { exact: true });
      await expect(title).toHaveValue("Hello", { timeout: 30_000 });

      await title.fill("Discard me");
      const drafts = `sites/${project.owner}/drafts/`;
      await expect
        .poll(
          async () =>
            Object.values(await deliveryObjects(page.request, drafts)).some(
              (o) => o.text.includes("Discard me"),
            ),
          { timeout: 30_000 },
        )
        .toBe(true);

      await page.getByRole("button", { name: "Review & Publish" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.locator('[data-publish-state="ready"]')).toBeVisible({
        timeout: 60_000,
      });
      // The dialog has main's "Hello"; main moves on before the discard.
      await moveStubMain(page.request, project.owner, "site", {
        ".deco/schema.gen.json": schema,
        ".deco/blocks/home.json": homePage.replace("Hello", "Hello again"),
      });
      await dialog.getByRole("button", { name: "Discard" }).first().click();
      await dialog
        .getByRole("button", { name: "Discard", exact: true })
        .click();
      await expect(dialog.getByText("Everything is published")).toBeVisible({
        timeout: 30_000,
      });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);

      // main's value as it is now, not the one the dialog showed.
      await expect(title).toHaveValue("Hello again", { timeout: 10_000 });
      const left = Object.values(await deliveryObjects(page.request, drafts));
      expect(left.some((o) => o.text.includes("Discard me"))).toBe(false);
      // The draft holds no copy of main: the block is simply not in it.
      expect(left.some((o) => /"title":\s*"Hello/.test(o.text))).toBe(false);

      // main moves again after the discard: the editor follows it.
      await moveStubMain(page.request, project.owner, "site", {
        ".deco/schema.gen.json": schema,
        ".deco/blocks/home.json": homePage.replace("Hello", "Hello third"),
      });
      await expect(title).toHaveValue("Hello third", { timeout: 60_000 });
    } finally {
      await preview.close();
    }
  });
});
