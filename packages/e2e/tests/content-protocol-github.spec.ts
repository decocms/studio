/**
 * The site editor's GitHub backend for Blocks v8 sites on the hosted Deco
 * CMS: the content protocol over main with the project's CDN draft layered
 * on, and the publish that commits that draft to main and releases it.
 *
 *   POST /api/:org/decofile/:virtualMcpId/:branch/rpc        (session, org flag)
 *   GET  /api/:org/decofile/:virtualMcpId/:branch            the draft pointer (session)
 *   POST /api/:org/decofile/:virtualMcpId/:branch/publish    commit + release
 *   /api/:org/hosted/:virtualMcpId/{releases,releases/current,site-tokens}
 *
 * The protocol's own black-box conformance suite runs against the endpoint,
 * with the repository on the local GitHub stub (see fixtures/fast-preview.ts)
 * and the delivery bucket on its stub (fixtures/delivery-stub-server.ts). The
 * cases below it cover what's specific to this backend: the flag, auth,
 * saves into the CDN draft (never git), v7 secret blocks left in a migrated
 * site, the `?__draft=` pointer the site revalidates with ETags, publish and
 * releases, site tokens, and the editor's v7/v8 detection: only a committed
 * schema with `"blocksMajor": 8` is a v8 site, even with the org flag on.
 */

import type { APIRequestContext } from "@playwright/test";
import type {
  BlocksApplyResult,
  BlocksListResult,
  DescribeResult,
} from "@decocms/blocks/protocol";
import { runConformance } from "@decocms/blocks/protocol/conformance";
import { publicKeyPemFromDer } from "@decocms/shared/secret-ciphertext";
import { signUpViaApi } from "../fixtures/auth-api";
import {
  createFastPreviewProject,
  type FastPreviewProject,
  inspectStubRepo,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
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

async function enableContentProtocol(
  ctx: APIRequestContext,
  orgSlug: string,
): Promise<void> {
  await callSelfMcpTool(ctx, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
    organizationId: await findOrgId(ctx, orgSlug),
    flags: { site_editor_content_protocol: true },
  });
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
      await enableContentProtocol(ctx, project.org);

      const report = await runConformance({
        endpoint: `${getE2EAppOrigin()}${rpcPath(project, "main")}`,
        fetch: contextFetch(ctx),
        secretField: { blockType: SECRET_BLOCK, field: SECRET_FIELD },
        secretsPublicKey: publicKey,
      });
      const failures = report.outcomes.filter((o) => o.status === "failed");
      expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
      expect(report.passed).toBeGreaterThan(20);
    } finally {
      await ctx.dispose();
    }
  });

  test("is off without the org flag, and needs a session", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const anon = await newApiContext(playwright);
    try {
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify(schema),
      });
      const path = rpcPath(project, "main");

      expect((await rpc(ctx, path, "describe")).status).toBe(404);

      await enableContentProtocol(ctx, project.org);
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
      await enableContentProtocol(ctx, project.org);
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
      const [draft] = Object.values(drafts);
      expect(JSON.parse(draft!.text)).toEqual({
        set: { "hero-home": hero },
        delete: ["promo"],
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
      await enableContentProtocol(ctx, project.org);

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

  test("never reads or writes a v7 site over /rpc, even with the flag on", async ({
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
      await enableContentProtocol(ctx, project.org);
      const path = rpcPath(project, "main");
      const headBefore = (await inspectStubRepo(ctx, project.owner, "site"))
        .refs;

      // It reads as schemaless, so the editor stays on the classic one.
      const read = await rpc<{ schema?: unknown }>(ctx, path, "schema.get");
      expect(read.error ?? read.result?.schema ?? null).not.toEqual(
        expect.objectContaining({ blocksMajor: expect.anything() }),
      );
      const applied = await rpc<BlocksApplyResult>(ctx, path, "blocks.apply", {
        set: { "hero-home": { __resolveType: "hero", title: "x" } },
      });
      expect(applied.error?.code).toBe(-32006);
      expect((await inspectStubRepo(ctx, project.owner, "site")).refs).toEqual(
        headBefore,
      );
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
      await enableContentProtocol(ctx, project.org);

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

  test("publish commits the draft to main and makes its release current; Make current switches the CDN", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify(schema),
        ".deco/blocks/hero-home.json": '{"__resolveType":"hero"}\n',
      });
      await enableContentProtocol(ctx, project.org);
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

      // Make an older release current: latest.json only, git stays.
      const made = await ctx.post(`${hosted}/releases/current`, {
        data: { sha: first.sha },
      });
      expect(made.status()).toBe(200);
      // Every latest.json write is stamped now (the SDK's timeline rule).
      const rolledBackAt = await publishedAt();
      expect(Date.parse(rolledBackAt)).toBeGreaterThan(Date.parse(secondAt));
      releases = await (await ctx.get(`${hosted}/releases`)).json();
      expect(releases).toMatchObject({ current: { revision: first.sha } });
      // A commit without a companion release can't be made current.
      const initial = releases.commits.at(-1).sha as string;
      expect(
        (
          await ctx.post(`${hosted}/releases/current`, {
            data: { sha: initial },
          })
        ).status(),
      ).toBe(404);

      // A Publish that commits nothing leaves latest.json alone.
      await rpc(ctx, rpcPath(project, "draft-1"), "blocks.apply", {
        set: { "hero-home": { __resolveType: "hero", title: "Two" } },
      });
      const noop = await ctx.post(`${decofile}/draft-1/publish`, {
        data: { note: "" },
      });
      expect(await noop.json()).toEqual({ result: "up-to-date" });
      expect(await publishedAt()).toBe(rolledBackAt);
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
      await enableContentProtocol(ctx, project.org);
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

  test("a siteSlug the org doesn't own gets no hosted features", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify(schema),
      });
      await enableContentProtocol(ctx, project.org);
      // Another org's site: members can edit metadata.siteSlug, so it must
      // never decide which site's delivery objects or tokens Studio writes.
      await callSelfMcpTool(ctx, project.org, "COLLECTION_VIRTUAL_MCP_UPDATE", {
        id: project.vmcpId,
        data: { metadata: { siteSlug: uniqueOwner() } },
      });
      const hosted = `/api/${project.org}/hosted/${project.vmcpId}`;
      expect((await ctx.post(`${hosted}/site-tokens`)).status()).toBe(404);
      expect((await ctx.get(`${hosted}/releases`)).status()).toBe(404);
      expect(
        (
          await ctx.post(`${hosted}/releases/current`, {
            data: { sha: "0".repeat(40) },
          })
        ).status(),
      ).toBe(404);
    } finally {
      await ctx.dispose();
    }
  });

  test("creating a project claims its siteSlug, never another org's", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const other = await newApiContext(playwright);
    try {
      // `setUp` creates the project with `siteSlug: owner`; nothing else
      // claims it, so site tokens working proves the claim.
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify(schema),
      });
      await enableContentProtocol(ctx, project.org);
      const tokens = `/api/${project.org}/hosted/${project.vmcpId}/site-tokens`;
      expect((await ctx.post(tokens)).status()).toBe(200);

      // Another org naming the same site gets no claim and no hosted features.
      const user = await signUpViaApi(other);
      await enableContentProtocol(other, user.orgSlug);
      const copy = await createFastPreviewProject(other, user.orgSlug, {
        owner: project.owner,
        repo: "site",
        siteSlug: project.owner,
      });
      const hosted = `/api/${copy.org}/hosted/${copy.vmcpId}`;
      expect((await other.post(`${hosted}/site-tokens`)).status()).toBe(404);
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

/** A Fast Preview project in the signed-in user's org, with the flag on. */
async function openEditor(
  api: APIRequestContext,
  orgSlug: string,
  previewServerUrl: string,
  files: Record<string, string>,
): Promise<{ url: string; project: FastPreviewProject }> {
  const owner = uniqueOwner();
  const project = await createFastPreviewProject(api, orgSlug, {
    owner,
    repo: "site",
    // The header's PR lookup dials this; a closed port fails fast.
    connectionUrl: "http://127.0.0.1:1/unused",
    previewServerUrl,
    siteSlug: owner,
  });
  await seedStubRepo(api, {
    owner,
    repo: "site",
    defaultBranch: "main",
    branches: { main: { files } },
  });
  await enableContentProtocol(api, orgSlug);
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

test.describe("v7/v8 detection with the org flag on", () => {
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
        await page.goto(url);
        // The classic editor (the org's `new_blocks_editor` is off): v8
        // sites always get the new one, so this is the v7 path.
        const blocks = page.getByTestId("blocks-panel");
        await expect(
          blocks.getByPlaceholder("Page name", { exact: true }),
        ).toHaveValue("Home", { timeout: 60_000 });
        await expect(page.getByTestId("content-version-badge")).toHaveCount(0);
      } finally {
        await preview.close();
      }
    });
  }

  test('a schema with "blocksMajor": 8 is a v8 site', async ({
    authedPage: { page, orgSlug },
  }) => {
    const preview = await startPreviewSite();
    try {
      const { url } = await openEditor(page.request, orgSlug, preview.url, {
        ".deco/schema.gen.json": JSON.stringify({ ...v7Meta, blocksMajor: 8 }),
        ".deco/blocks/home.json": homePage,
      });
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
      await enableContentProtocol(ctx, project.org);
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
