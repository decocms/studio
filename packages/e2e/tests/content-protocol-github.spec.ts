/**
 * The site editor's GitHub backend for next-major Blocks sites: the content
 * protocol served over a project's repository.
 *
 *   POST /api/:org/decofile/:virtualMcpId/:branch/rpc          (session, org flag)
 *   GET  /api/:org/decofile/:virtualMcpId/:branch/draft-grant  (session, org flag)
 *
 * The protocol's own black-box conformance suite runs against the endpoint,
 * with the repository on the local GitHub stub (see fixtures/fast-preview.ts).
 * The cases below it cover what's specific to this backend: the flag, auth,
 * the bound branch, branch creation on first write, the tracked
 * `blocks.gen.json` and a legacy (v7) site's secret blocks.
 */

import type { APIRequestContext } from "@playwright/test";
import type {
  BlocksApplyResult,
  BlocksListResult,
  DescribeResult,
} from "@decocms/blocks/protocol";
import { publicKeyPemFromDer } from "@decocms/shared/secret-ciphertext";
import { runConformance } from "../fixtures/blocks-protocol";
import { signUpViaApi } from "../fixtures/auth-api";
import {
  createFastPreviewProject,
  type FastPreviewProject,
  inspectStubRepo,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, getE2EAppOrigin, newApiContext, test } from "../fixtures/test";

const SECRET_BLOCK = "newsletter";
const SECRET_FIELD = "apiKey";

/** A small deco-meta@1 schema with a block type that has a Secret field. */
const schema = {
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
      const grantPath = path.replace(/\/rpc$/, "/draft-grant");

      expect((await rpc(ctx, path, "describe")).status).toBe(404);
      expect((await ctx.get(grantPath)).status()).toBe(404);

      await enableContentProtocol(ctx, project.org);
      const described = await rpc<DescribeResult>(ctx, path, "describe");
      expect(described.result).toMatchObject({
        protocol: "deco-content",
        server: { name: "studio-github" },
        kind: "git",
        root: ".",
        refs: { default: "main", autoCreate: true },
        assets: null,
        preview: { origin: "https://site.example.com" },
      });
      const grant = await ctx.get(grantPath);
      expect(grant.status()).toBe(200);
      expect(await grant.json()).toMatchObject({
        token: expect.any(String),
        apiHost: expect.any(String),
      });

      expect((await rpc(anon, path, "describe")).status).toBe(401);
      expect((await anon.get(grantPath)).status()).toBe(401);
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
        ".deco/meta.gen.json": JSON.stringify(schema),
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

  test("saves a legacy site's secret loader blocks", async ({ playwright }) => {
    const ctx = await newApiContext(playwright);
    try {
      const loader = "website/loaders/secret.ts";
      // v7 `meta.gen.json`: the loader marks its encrypted string `format: secret`.
      const legacyMeta = {
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
        ".deco/meta.gen.json": JSON.stringify(legacyMeta),
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
});
