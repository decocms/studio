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
 * saves into the CDN draft (never git; an editor's save, with its main-answer
 * header, reads the draft alone), v7 secret loader blocks saved as plain
 * blocks, the `?__draft=` pointer the site revalidates with ETags, publish and
 * releases, site tokens, and the editor's v7/v8 detection: only a committed
 * schema with `"blocksMajor": 8` is a v8 site, in any org (no flag).
 */

import type { APIRequestContext } from "@playwright/test";
import type {
  BlocksApplyResult,
  BlocksListResult,
  DescribeResult,
} from "@decocms/blocks/protocol";
import { createServer } from "node:http";
import { spellingKey } from "@decocms/blocks/protocol";
import { runConformance } from "@decocms/blocks/protocol/conformance";
import { isV8Schema } from "@decocms/shared/blocks-major";
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
  Record<
    string,
    {
      text: string;
      etag: string;
      cacheControl: string | null;
      metadata?: Record<string, string>;
    }
  >
> {
  const res = await ctx.get(
    `${DELIVERY_STUB_ORIGIN}/__admin/objects?prefix=${encodeURIComponent(prefix)}`,
  );
  expect(res.ok()).toBe(true);
  return (await res.json()) as Record<
    string,
    {
      text: string;
      etag: string;
      cacheControl: string | null;
      metadata?: Record<string, string>;
    }
  >;
}

/** A small v8 schema (deco-meta@1, `"blocksMajor": 8` as `deco schema` writes it). */
const schema = {
  blocksMajor: 8,
  manifest: {
    blocks: {
      sections: {
        hero: { $ref: "#/definitions/aGVybw==" },
      },
    },
  },
  schema: {
    definitions: {
      "aGVybw==": {
        type: "object",
        properties: { title: { type: "string" } },
      },
    },
  },
};

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
      // One socket per request: the suite's oversize-body case is answered
      // 413 before the body is read, the dev/preview proxy then breaks that
      // socket (EPIPE), and a later request reusing it fails with ECONNRESET.
      headers: { ...Object.fromEntries(request.headers), connection: "close" },
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

/**
 * A save through main's preconditions (`ifMatch`), as a protocol client
 * reads them: each name's version as `blocks.list` reports it (main's under
 * the draft), `null` for one the site doesn't have. The hosted route refuses
 * a save without them. (The editor's own save, with its main-answer header,
 * is guarded by the draft alone instead; see "saves into the CDN draft".)
 */
async function listedIfMatch(
  ctx: APIRequestContext,
  path: string,
  names: string[],
): Promise<Record<string, string | null>> {
  const listed = await rpc<BlocksListResult>(ctx, path, "blocks.list");
  const versions = listed.result?.notModified
    ? {}
    : (listed.result?.versions ?? {});
  return Object.fromEntries(
    names.map((name) => [name, guardOf(versions, name)]),
  );
}

/** `name`'s listed version under any of its spellings, or null. */
function guardOf(
  versions: Record<string, string>,
  name: string,
): string | null {
  const key = spellingKey(name);
  const listed = Object.keys(versions).find((n) => spellingKey(n) === key);
  return listed === undefined ? null : versions[listed]!;
}

/** The protocol's request size limit: a body over it is answered 413 first. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The conformance suite's fetch on the hosted route, as a client that reads
 * before it writes: every name a `blocks.apply` leaves unguarded gets the
 * version `blocks.list` reports just before ({@link listedIfMatch}). The
 * hosted route refuses an unguarded save (asserted next to the suite), so
 * that is the only client it serves; the guards a case sends itself (a
 * stale version, create-only `null`) go as sent, and a body over the size
 * limit goes untouched (its 413 comes before any precondition).
 */
function guardingFetch(
  ctx: APIRequestContext,
  send: (request: Request) => Promise<Response>,
) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return send(request);
    const text = await request.clone().text();
    if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) return send(request);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return send(request);
    }
    const calls = (Array.isArray(body) ? body : [body]).filter(
      (call): call is { method: string; params: Record<string, unknown> } =>
        isRecord(call) &&
        call.method === "blocks.apply" &&
        isRecord(call.params),
    );
    if (calls.length === 0) return send(request);
    const listed = await ctx.post(request.url, {
      data: { jsonrpc: "2.0", id: 1, method: "blocks.list", params: {} },
    });
    const versions =
      (
        (await listed.json()) as {
          result?: { versions?: Record<string, string> };
        }
      ).result?.versions ?? {};
    for (const call of calls) {
      const { set, delete: deletes, ifMatch } = call.params;
      const guards = isRecord(ifMatch) ? { ...ifMatch } : {};
      const names = [
        ...(isRecord(set) ? Object.keys(set) : []),
        ...(Array.isArray(deletes)
          ? deletes.filter((n): n is string => typeof n === "string")
          : []),
      ];
      for (const name of names) {
        if (Object.hasOwn(guards, name)) continue;
        // Defined, not assigned: a case's `__proto__` is a name like any other.
        Object.defineProperty(guards, name, {
          value: guardOf(versions, name),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      call.params = { ...call.params, ifMatch: guards };
    }
    return send(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(body),
      }),
    );
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

/**
 * The session read of a hosted v8 project: its CDN draft pointer, and who last
 * changed each block the draft holds (Studio user ids, ISO times).
 */
interface DraftPointer {
  draft: string | null;
  version: string | null;
  changedBy: Record<string, { userId: string; at: string }>;
}

/** The session read, as the v8 editor makes it: its CDN draft pointer. */
async function draftPointer(
  ctx: APIRequestContext,
  project: FastPreviewProject,
  branch: string,
): Promise<DraftPointer> {
  const res = await ctx.get(
    `/api/${project.org}/decofile/${project.vmcpId}/${branch}`,
  );
  expect(res.status()).toBe(200);
  return (await res.json()) as DraftPointer;
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
      const project = await setUp(ctx, {
        ".deco/schema.gen.json": JSON.stringify(schema),
        ".deco/blocks/hero-home.json": '{"__resolveType":"hero"}\n',
      });
      expect(await refreshV8(ctx, project)).toBe(true);

      const report = await runConformance(
        {
          endpoint: `${getE2EAppOrigin()}${rpcPath(project, "main")}`,
          fetch: guardingFetch(ctx, contextFetch(ctx)),
          // On main and untouched: the changes.* cases modify and restore it.
          baseEntry: { name: "hero-home" },
        },
        // "Without guards, the later of two writes wins" can't hold here:
        // the hosted route has no unguarded writes, so of two concurrent
        // writes built on the same version one is refused (asserted below).
        (testCase) => testCase.id !== "apply/last-writer-wins",
      );
      const failures = report.outcomes.filter((o) => o.status === "failed");
      expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
      expect(report.passed).toBeGreaterThan(20);

      // What the guarding fetch stands in for: an unguarded save is refused
      // (InvalidParams, naming the block), and nothing is written.
      const path = rpcPath(project, "main");
      const unguarded = await rpc(ctx, path, "blocks.apply", {
        set: { "hero-home": { __resolveType: "hero", title: "Unguarded" } },
      });
      expect(unguarded.error).toMatchObject({
        code: -32602,
        data: { missing: ["hero-home"] },
      });
      const listed = await rpc<BlocksListResult>(ctx, path, "blocks.list");
      expect(listed.result).toMatchObject({
        blocks: { "hero-home": { __resolveType: "hero" } },
      });
      expect(JSON.stringify(listed.result)).not.toContain("Unguarded");

      // Two concurrent writes built on the same version: one lands, the
      // other is a Conflict, never written over unseen.
      const raced = await Promise.all(
        ["a", "b"].map((from) =>
          rpc<BlocksApplyResult>(ctx, path, "blocks.apply", {
            set: { raced: { __resolveType: "hero", title: from } },
            ifMatch: { raced: null },
          }),
        ),
      );
      expect(raced.map((r) => r.error?.code ?? "ok").sort()).toEqual([
        -32002,
        "ok",
      ]);
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
        ifMatch: await listedIfMatch(ctx, path, ["hero-home", "promo"]),
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
      // One object: exactly { set, delete } as JSON; who changed each name
      // is in its storage metadata, never in the JSON.
      expect(Object.keys(drafts)).toHaveLength(1);
      const [draft] = Object.values(drafts);
      expect(JSON.parse(draft!.text)).toEqual({
        set: { "hero-home": hero },
        delete: ["promo"],
      });
      expect(draft!.text).not.toMatch(/__meta|userId|lastEdited/);
      const edited = draft!.metadata?.["x-amz-meta-deco-edited"] ?? "";
      expect(
        edited
          .split(";")
          .map((entry) => entry.split(",")[0])
          .sort(),
      ).toEqual(["hero-home", "promo"]);
      expect(draft!.cacheControl).toBe("no-cache, max-age=0, must-revalidate");

      const after = await rpc<BlocksListResult>(ctx, path, "blocks.list");
      expect(after.result).toMatchObject({
        revision: applied.result?.revision,
        blocks: { "hero-home": hero },
      });
      expect(
        (after.result as { blocks?: Record<string, unknown> }).blocks,
      ).not.toHaveProperty("promo");

      // The editor's own save (its main-answer header) reads the draft
      // alone: guarded by the draft's version, answered with no main part.
      const retitled = { __resolveType: "hero", title: "Again" };
      const saved = await ctx.post(path, {
        headers: { "x-deco-main-schema": "v8" },
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "blocks.apply",
          params: {
            set: { "hero-home": retitled },
            ifMatch: { "hero-home": applied.result?.versions["hero-home"] },
          },
        },
      });
      const savedBody = (await saved.json()) as {
        result?: BlocksApplyResult;
      };
      expect(savedBody.result?.revision).toMatch(/^~/);
      const again = await rpc<BlocksListResult>(ctx, path, "blocks.list");
      expect(again.result).toMatchObject({
        blocks: { "hero-home": retitled },
      });
    } finally {
      await ctx.dispose();
    }
  });

  // Secrets are no longer the content framework's (the deploy platform owns
  // them): a v7 secret loader block left in a migrated site is a plain
  // block, saved exactly as written, with no secret check or encryption.
  test("saves a v7 secret loader block a migrated site still has as a plain block", async ({
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

      const site = {
        __resolveType: "site/apps/site.ts",
        apiKey: {
          __resolveType: loader,
          name: "API_KEY",
          encrypted: "0a1b2c3d",
        },
      };
      const applied = await rpc<BlocksApplyResult>(
        ctx,
        rpcPath(project, "main"),
        "blocks.apply",
        {
          set: { site },
          ifMatch: await listedIfMatch(ctx, rpcPath(project, "main"), ["site"]),
        },
      );
      expect(applied.error).toBeUndefined();
      expect(applied.result?.revision).toEqual(expect.any(String));
      const listed = await rpc<BlocksListResult>(
        ctx,
        rpcPath(project, "main"),
        "blocks.list",
      );
      expect(
        (listed.result as { blocks?: Record<string, unknown> }).blocks?.site,
      ).toEqual(site);
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

      // An open editor (acting on v8) saves within the gate's minute: a save
      // reads the draft alone (never main), so it lands in the draft, which
      // a v7 site never reads, and nothing is committed. Its next read of
      // main is told main changed.
      const saved = await ctx.post(path, {
        headers: { "x-deco-main-schema": "v8" },
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "blocks.apply",
          params: {
            set: { "hero-home": { __resolveType: "hero", title: "x" } },
            ifMatch: { "hero-home": null },
          },
        },
      });
      expect(saved.status()).toBe(200);
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

      // Nothing saved yet: the editor's read creates the empty draft, so the
      // pointer exists before the first save.
      const host = new URL(DELIVERY_STUB_ORIGIN).host;
      const empty = await draftPointer(ctx, project, "draft-1");
      expect(empty.draft).toMatch(
        new RegExp(
          `^${host}/sites/${project.owner}/drafts/[A-Za-z0-9_-]{22}\\.json$`,
        ),
      );
      expect(empty.version).toEqual(expect.any(String));
      expect(empty.changedBy).toEqual({});
      expect(
        await (
          await site.get(`http://${empty.draft}?v=${empty.version}`)
        ).json(),
      ).toEqual({ set: {}, delete: [] });

      const hero = { __resolveType: "hero", title: "Summer" };
      await rpc<BlocksApplyResult>(
        ctx,
        rpcPath(project, "draft-1"),
        "blocks.apply",
        {
          set: { "hero-home": hero },
          ifMatch: await listedIfMatch(ctx, rpcPath(project, "draft-1"), [
            "hero-home",
          ]),
        },
      );
      const pointer = await draftPointer(ctx, project, "draft-1");
      // The save lands in that same draft: same address, a new version.
      expect(pointer.draft).toBe(empty.draft);
      expect(pointer.version).toEqual(expect.any(String));
      expect(pointer.version).not.toBe(empty.version);
      // The save recorded its editor next to the draft, not in it.
      expect(pointer.changedBy).toEqual({
        "hero-home": { userId: expect.any(String), at: expect.any(String) },
      });

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
        ifMatch: await listedIfMatch(ctx, rpcPath(project, "draft-1"), [
          "hero-home",
        ]),
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
          ifMatch: await listedIfMatch(ctx, rpcPath(project, "draft-1"), [
            "hero-home",
          ]),
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
        "previewHosts",
        "publishedAt",
        "revision",
        "schemaHash",
      ]);
      expect(latest.revision).toBe(first.sha);
      // The hosts the site shows drafts on: always this machine's.
      expect(latest.previewHosts).toEqual(
        expect.arrayContaining(["localhost", "127.0.0.1", "[::1]"]),
      );
      // The draft is emptied in place, once the release is live: same
      // address, nothing of its own left.
      const drafts = Object.entries(objects).filter(([k]) =>
        k.includes("/drafts/"),
      );
      expect(drafts).toHaveLength(1);
      expect(JSON.parse(drafts[0]![1].text)).toEqual({ set: {}, delete: [] });

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
        message: "Made current: Publish One",
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
        ifMatch: await listedIfMatch(ctx, rpcPath(project, "draft-1"), [
          "hero-home",
        ]),
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

  test("a saved section's change compares on a page that shows it, never on v7's /live/previews", async ({
    authedPage: { page, orgSlug },
  }) => {
    // A v8 site: its pages answer, and v7's isolated-section route is a 404.
    const site = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://site").pathname;
      const found = !path.startsWith("/live/previews");
      response.writeHead(found ? 200 : 404, {
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(
        `<!doctype html><html><body><h1>${found ? `Site page ${path}` : "Not Found"}</h1></body></html>`,
      );
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const address = site.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const siteUrl = `http://127.0.0.1:${address.port}`;
    try {
      const header = { __resolveType: "site/sections/Hero.tsx", title: "Top" };
      const { url, project } = await openEditor(
        page.request,
        orgSlug,
        siteUrl,
        {
          ".deco/schema.gen.json": JSON.stringify({
            ...v7Meta,
            blocksMajor: 8,
          }),
          ".deco/blocks/Header.json": JSON.stringify(header),
          // A saved section no page uses.
          ".deco/blocks/Popup.json": JSON.stringify(header),
          ".deco/blocks/home.json": JSON.stringify({
            __resolveType: "website/pages/Page.tsx",
            name: "Home",
            path: "/",
            sections: [{ __resolveType: "Header" }],
          }),
        },
      );
      await page.goto(url);
      await expect(page.getByTestId("content-version-badge")).toHaveText("v8", {
        timeout: 60_000,
      });
      // The saved Header changes in the draft, as a save from its form does.
      const applied = await rpc<BlocksApplyResult>(
        page.request,
        rpcPath(project, "main"),
        "blocks.apply",
        {
          set: {
            Header: { ...header, title: "Top, changed" },
            Popup: { ...header, title: "Popup, changed" },
          },
          ifMatch: await listedIfMatch(page.request, rpcPath(project, "main"), [
            "Header",
            "Popup",
          ]),
        },
      );
      expect(applied.result?.revision).toBeTruthy();

      await page.getByRole("button", { name: "Review & Publish" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.locator('[data-publish-state="ready"]')).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        dialog.getByText(
          /This block can appear on several pages\. Showing: \//,
        ),
      ).toBeVisible({ timeout: 30_000 });
      for (const side of ["Before", "After"]) {
        const frame = dialog.locator(`iframe[title="${side}"]`);
        await expect(frame).toHaveAttribute(
          "src",
          /^http:\/\/127\.0\.0\.1:\d+\/\?/,
          {
            timeout: 30_000,
          },
        );
        const src = (await frame.getAttribute("src"))!;
        expect(new URL(src).pathname).toBe("/");
        await expect(
          page.frameLocator(`iframe[title="${side}"]`).getByRole("heading"),
        ).toHaveText("Site page /", { timeout: 30_000 });
      }
      // The published side is the live page; the other carries the draft.
      const before = await dialog
        .locator('iframe[title="Before"]')
        .getAttribute("src");
      const after = await dialog
        .locator('iframe[title="After"]')
        .getAttribute("src");
      expect(new URL(before!).searchParams.get("__draft")).toBe("off");
      expect(new URL(after!).searchParams.get("__draft")).not.toBe("off");

      // A block no page uses has nothing to preview: the code only, saying why.
      await dialog.getByText("Popup", { exact: true }).click();
      await expect(
        dialog.getByText(
          "This block isn't used on any page, so there's nothing to preview. Here are the changes.",
        ),
      ).toBeVisible({ timeout: 30_000 });
      await expect(dialog.getByRole("tab", { name: "Code" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(
        dialog.getByRole("tab", { name: "Side by side" }),
      ).toHaveCount(0);
      // (The Header's pane stays mounted, hidden: only the shown one counts.
      // On a v8 site a hidden pane stays laid out, transparent and
      // aria-hidden, so "shown" is visible and outside an aria-hidden pane.)
      await expect(
        dialog.getByRole("textbox", { name: "Page address" }),
      ).toHaveCount(0);
      await expect
        .poll(() =>
          dialog
            .locator("iframe")
            .filter({ visible: true })
            .evaluateAll(
              (frames) =>
                frames.filter((f) => !f.closest('[aria-hidden="true"]')).length,
            ),
        )
        .toBe(0);
      await expect(dialog.getByText("Popup, changed").first()).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      site.closeAllConnections();
      await new Promise<void>((resolve) => site.close(() => resolve()));
    }
  });

  test("a field another editor also changed asks whose version to keep, saying who and when", async ({
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
      await page.goto(url);
      await expect(page.getByTestId("content-version-badge")).toHaveText("v8", {
        timeout: 60_000,
      });
      const blocks = page.getByTestId("blocks-panel");
      await blocks.getByText("Hero", { exact: true }).first().click();
      const title = page.getByLabel("Title", { exact: true });
      await expect(title).toHaveValue("Hello", { timeout: 30_000 });

      // The same user, in another tab, saves the page with another title:
      // the draft object's metadata records them as its editor.
      const theirs = {
        ...JSON.parse(homePage),
        sections: [
          { __resolveType: "site/sections/Hero.tsx", title: "Theirs" },
        ],
      };
      const applied = await rpc(
        page.request,
        rpcPath(project, "main"),
        "blocks.apply",
        {
          set: { home: theirs },
          ifMatch: await listedIfMatch(page.request, rpcPath(project, "main"), [
            "home",
          ]),
        },
      );
      expect(applied.status).toBe(200);
      expect(applied.error).toBeUndefined();

      await title.fill("Mine");
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      const field = dialog.getByRole("radiogroup", { name: "Title" });
      await expect(field.getByTestId("conflict-mine")).toHaveText("Mine");
      await expect(field.getByTestId("conflict-theirs")).toHaveText("Theirs");
      // The window opens at once, its title naming the field as the form
      // labels it: it names who only when that was already known as it
      // opened, and names no one for as long as it is open otherwise.
      await expect(dialog).toHaveAccessibleName(
        /^(You changed the Title in another tab or window|The Title was changed while you were editing)$/,
      );
      // The draft's metadata says who and when: here the viewer, from the
      // RPC above. Their card says so once it is read.
      const theirCard = field.getByRole("radio", {
        name: "You, in another tab or window",
      });
      await expect(theirCard).toBeVisible({ timeout: 15_000 });
      await expect(theirCard).toHaveAccessibleDescription(/^saved .+ Theirs$/);

      // Yours is chosen: one click on OK saves the user's version.
      await expect(
        field.getByRole("radio", { name: "You", exact: true }),
      ).toBeChecked();
      await expect(theirCard).not.toBeChecked();
      await dialog.getByRole("button", { name: "OK", exact: true }).click();
      await expect(dialog).toBeHidden();
      const drafts = `sites/${project.owner}/drafts/`;
      await expect
        .poll(
          async () =>
            Object.values(await deliveryObjects(page.request, drafts)).some(
              (o) => o.text.includes('"Mine"'),
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      // Still one object, its JSON free of editor data.
      const objects = Object.values(
        await deliveryObjects(page.request, drafts),
      );
      expect(objects).toHaveLength(1);
      expect(objects[0]!.text).not.toMatch(/__meta|userId|lastEdited/);
      expect(objects[0]!.metadata?.["x-amz-meta-deco-edited"]).toMatch(
        /^home,/,
      );
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
