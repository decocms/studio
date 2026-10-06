/**
 * The site editor's GitHub backend for next-major Blocks sites: the content
 * protocol served over a project's repository.
 *
 *   POST /api/:org/decofile/:virtualMcpId/:branch/rpc              (session, org flag)
 *   GET  /api/:org/decofile/:virtualMcpId/:branch/changes          (draft token or session, org flag)
 *   GET  /api/:org/decofile/:virtualMcpId/:branch/draft-token      (session, org flag)
 *
 * The protocol's own black-box conformance suite runs against the endpoint,
 * with the repository on the local GitHub stub (see fixtures/fast-preview.ts).
 * The cases below it cover what's specific to this backend: the flag, auth,
 * the bound branch, branch creation on first write, the tracked
 * `blocks.gen.json`, v7 secret blocks left in a migrated site, the draft
 * changes the site's `cms.forDraft` reads through its Fast Preview pointer,
 * and the editor's v7/v8 detection: only a committed schema with
 * `"blocksMajor": 8` is a v8 site, even with the org flag on.
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
      const changesPath = path.replace(/\/rpc$/, "/changes");
      const tokenPath = path.replace(/\/rpc$/, "/draft-token");

      expect((await rpc(ctx, path, "describe")).status).toBe(404);
      expect((await ctx.get(changesPath)).status()).toBe(404);
      expect((await ctx.get(tokenPath)).status()).toBe(404);

      await enableContentProtocol(ctx, project.org);
      const described = await rpc<DescribeResult>(ctx, path, "describe");
      expect(described.result).toMatchObject({
        protocol: "deco-content",
        server: { name: "studio-github" },
        kind: "git",
        root: ".",
        refs: { default: "main", autoCreate: true },
        assets: null,
        preview: { url: "https://site.example.com" },
      });

      expect((await rpc(anon, path, "describe")).status).toBe(401);
      expect((await anon.get(changesPath)).status()).toBe(401);
      expect((await anon.get(tokenPath)).status()).toBe(401);
      // A draft token reads changes, but never mints another token.
      const { token } = (await (await ctx.get(tokenPath)).json()) as {
        token: string;
      };
      const q = `?token=${encodeURIComponent(token)}`;
      expect((await anon.get(`${changesPath}${q}`)).status()).toBe(200);
      expect((await anon.get(`${tokenPath}${q}`)).status()).toBe(401);
    } finally {
      await ctx.dispose();
      await anon.dispose();
    }
  });

  test("reads the default branch until the first write creates the branch", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify(schema),
        ".deco/blocks.gen.json": '{"hero-home":{"__resolveType":"hero"}}',
        ".deco/blocks/hero-home.json": '{"__resolveType":"hero"}\n',
      });
      await enableContentProtocol(ctx, project.org);
      const path = rpcPath(project, "draft-1");

      const before = await rpc<BlocksListResult>(ctx, path, "blocks.list");
      expect(before.result).toMatchObject({
        resolvedRef: "main",
        blocks: { "hero-home": { __resolveType: "hero" } },
      });
      expect(
        (await rpc(ctx, path, "blocks.list", { ref: "main" })).error?.code,
      ).toBe(-32006);
      expect((await inspectStubRepo(ctx, project.owner, "site")).refs).toEqual({
        main: expect.any(String),
      });

      const applied = await rpc<BlocksApplyResult>(ctx, path, "blocks.apply", {
        set: { "pages-Home": { __resolveType: "hero", title: "Hi" } },
      });
      expect(applied.result?.revision).toEqual(expect.any(String));

      const repo = await inspectStubRepo(ctx, project.owner, "site");
      expect(repo.refs["draft-1"]).toBe(applied.result?.revision);
      expect(repo.refs["main"]).not.toBe(repo.refs["draft-1"]);
      const files = repo.branches["draft-1"]!.files;
      expect(files[".deco/blocks/pages-Home.json"]).toBe(
        `${JSON.stringify({ __resolveType: "hero", title: "Hi" }, null, 2)}\n`,
      );
      // The tracked merged artifact is regenerated in the same commit.
      expect(JSON.parse(files[".deco/blocks.gen.json"]!)).toEqual({
        "hero-home": { __resolveType: "hero" },
        "pages-Home": { __resolveType: "hero", title: "Hi" },
      });

      const after = await rpc<BlocksListResult>(ctx, path, "blocks.list");
      expect(after.result).toMatchObject({
        resolvedRef: "draft-1",
        revision: applied.result?.revision,
      });
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

  test("a draft's pointer answers only what its branch changed", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const site = await newApiContext(playwright);
    try {
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify(schema),
        ".deco/blocks/hero-home.json": '{"__resolveType":"hero"}\n',
        ".deco/blocks/promo.json": '{"__resolveType":"hero","title":"Old"}\n',
        ".deco/blocks/footer.json": '{"__resolveType":"hero","title":"F"}\n',
      });
      await enableContentProtocol(ctx, project.org);
      const base = `/api/${project.org}/decofile/${project.vmcpId}`;

      // Before the first save the branch doesn't exist: nothing changed.
      const fresh = await ctx.get(`${base}/draft-1/changes`);
      expect(fresh.status()).toBe(200);
      expect(await fresh.json()).toEqual({ format: 1, set: {}, delete: [] });

      const hero = { __resolveType: "hero", title: "Summer" };
      const applied = await rpc<BlocksApplyResult>(
        ctx,
        rpcPath(project, "draft-1"),
        "blocks.apply",
        { set: { "hero-home": hero }, delete: ["promo"] },
      );
      expect(applied.result?.revision).toEqual(expect.any(String));

      const minted = await ctx.get(`${base}/draft-1/draft-token`);
      expect(minted.status()).toBe(200);
      expect(minted.headers()["cache-control"]).toBe("no-store");
      const { token, apiHost } = (await minted.json()) as {
        token: string;
        apiHost: string;
      };
      expect(apiHost).toEqual(expect.any(String));
      const q = `?token=${encodeURIComponent(token)}`;

      // What the site's SDK fetches: only the draft's changes, footer inherits production.
      const changes = await site.get(`${base}/draft-1/changes${q}&v=x`);
      expect(changes.status()).toBe(200);
      expect(changes.headers()["cache-control"]).toBe("no-store");
      expect(changes.headers()["access-control-allow-origin"]).toBe("*");
      expect(await changes.json()).toEqual({
        format: 1,
        set: { "hero-home": hero },
        delete: ["promo"],
      });

      // The token is scoped to its branch.
      expect((await site.get(`${base}/main/changes${q}`)).status()).toBe(401);
      expect(
        (await site.get(`${base}/draft-1/changes?token=forged`)).status(),
      ).toBe(401);

      // The v7 pointer is untouched: the whole decofile, as before.
      const legacy = await site.get(`${base}/draft-1${q}`);
      expect(legacy.status()).toBe(200);
      const decofile = (await legacy.json()) as Record<string, unknown>;
      expect(decofile["hero-home"]).toEqual(hero);
      expect(decofile.footer).toEqual({ __resolveType: "hero", title: "F" });
      expect(decofile.promo).toBeUndefined();
    } finally {
      await ctx.dispose();
      await site.dispose();
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
