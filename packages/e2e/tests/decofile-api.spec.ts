/**
 * End-to-end tests for the sandbox-less decofile API:
 *
 *   GET    /api/:org/decofile/:virtualMcpId/:branch           read (session OR ?token=)
 *   PATCH  /api/:org/decofile/:virtualMcpId/:branch           write blocks (session)
 *   POST   /api/:org/decofile/:virtualMcpId/:branch/publish   merge into default (session)
 *   GET    /api/:org/decofile/:virtualMcpId/:branch/status    drift vs default (session)
 *
 * All GitHub traffic lands on the local Git Data stub (fixtures/github-stub.ts,
 * wired via GITHUB_API_BASE_URL in the Playwright config) — nothing reaches
 * api.github.com. The GitHub token mint is short-circuited by pre-seeding an
 * unexpired downstream token on the repo-scoped child connection (the same
 * recipe github-import-repo-scope.spec.ts uses).
 *
 * Contract shapes are INLINED here (black-box suite — no app imports):
 *   - GET body (session): { version: <head sha>, token: <draft token>,
 *     apiHost: <authority serving this API>, decofile: {...} }
 *     where decofile keys are the percent-DECODED (until stable) stems of
 *     `.deco/blocks/*.json` files at the branch head.
 *   - ETag = `"<head sha>"`; If-None-Match on it -> 304.
 *   - PATCH writes land as ONE commit per request batch, blocks serialized as
 *     pretty-printed JSON + trailing newline; deleting a key removes EVERY
 *     alias file whose stem decodes to that key.
 */

import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

const GITHUB_STUB_ORIGIN = `http://localhost:${process.env.GITHUB_STUB_PORT ?? "4102"}`;

/** Serialization the decofile writer uses for a block file. */
const blockFileContent = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

interface DecofileGetBody {
  version: string;
  token?: string;
  apiHost?: string;
  decofile: Record<string, unknown>;
}

interface StubRepoInspection {
  defaultBranch: string;
  mergeMode: string;
  refs: Record<string, string>;
  commits: Array<{ sha: string; message: string; parents: string[] }>;
  branches: Record<string, { headSha: string; files: Record<string, string> }>;
}

async function seedStubRepo(
  ctx: APIRequestContext,
  params: {
    owner: string;
    repo: string;
    defaultBranch?: string;
    branches?: Record<string, { files?: Record<string, string> } | null>;
    mergeMode?: "merge" | "conflict" | "blocked";
  },
): Promise<void> {
  const res = await ctx.post(`${GITHUB_STUB_ORIGIN}/__admin/repos`, {
    data: params,
  });
  expect(res.ok()).toBe(true);
}

async function inspectStubRepo(
  ctx: APIRequestContext,
  owner: string,
  repo: string,
): Promise<StubRepoInspection> {
  const res = await ctx.get(
    `${GITHUB_STUB_ORIGIN}/__admin/repos/${owner}/${repo}`,
  );
  expect(res.ok()).toBe(true);
  return (await res.json()) as StubRepoInspection;
}

interface FastPreviewProject {
  org: string;
  owner: string;
  repo: string;
  vmcpId: string;
  childConnectionId: string;
}

/**
 * Full Fast Preview project wiring: repo-scoped GitHub child + unexpired
 * downstream token + a virtual MCP carrying the Fast Preview gate.
 * `repoScopeMode` picks which real repo-child shape to seed; the two resolve
 * credentials down different paths (see `client-for-repo`), and the default is
 * the one every repo imported since refreshable grants landed actually has.
 */
async function createFastPreviewProject(
  ctx: APIRequestContext,
  org: string,
  params: {
    owner: string;
    repo: string;
    repoScopeMode?: "refreshable" | "legacy-mint";
  },
): Promise<FastPreviewProject> {
  const { owner, repo, repoScopeMode = "refreshable" } = params;

  const sourceConnectionId =
    repoScopeMode === "legacy-mint"
      ? (
          await createHttpConnection(ctx, org, {
            title: `Org GitHub ${Date.now()}`,
            url: "https://example.com/mcp",
          })
        ).id
      : undefined;

  const child = await callSelfMcpTool<{ item: { id: string } }>(
    ctx,
    org,
    "COLLECTION_CONNECTIONS_CREATE",
    {
      data: {
        title: `GitHub: ${owner}/${repo}`,
        app_name: "mcp-github",
        connection_type: "HTTP",
        connection_url: "https://example.com/mcp",
        metadata: {
          repoScope: {
            ...(sourceConnectionId ? { sourceConnectionId } : {}),
            installationId: 1,
            repositoryId: 99,
            owner,
            repo,
            permissions: { contents: "write" },
          },
        },
      },
    },
  );
  const childConnectionId = child.item.id;
  expect(childConnectionId).toBeTruthy();

  // Unexpired token: read back directly, or short-circuits the legacy mint.
  const tokenRes = await ctx.post(
    `/api/${org}/connections/${childConnectionId}/oauth-token`,
    {
      data: { accessToken: "ghs_e2e_dummy", expiresIn: 3600 },
      headers: { "Content-Type": "application/json" },
    },
  );
  expect(tokenRes.ok()).toBe(true);

  const vmcp = await callSelfMcpTool<{ item: { id: string } }>(
    ctx,
    org,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: `${repo} ${Date.now()}`,
        metadata: {
          fastPreview: true,
          previewServerUrl: `https://${repo}.example.com`,
          githubRepo: {
            owner,
            name: repo,
            url: `https://github.com/${owner}/${repo}`,
            installationId: 1,
            connectionId: childConnectionId,
          },
        },
        connections: [{ connection_id: childConnectionId }],
      },
    },
  );
  const vmcpId = vmcp.item.id;
  expect(vmcpId).toBeTruthy();

  return { org, owner, repo, vmcpId, childConnectionId };
}

/** Unique owner per test run keeps the stub's repo namespace parallel-safe. */
const uniqueOwner = (): string => `e2e-${randomUUID().slice(0, 12)}`;

const decofileUrl = (p: FastPreviewProject, branch: string): string =>
  `/api/${p.org}/decofile/${p.vmcpId}/${branch}`;

test.describe("decofile API", () => {
  test("session GET on a nonexistent branch creates it from the default head; anonymous stays 404", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
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
        branches: {
          main: { files: { ".deco/blocks/Hero.json": '{"n":1}\n' } },
        },
      });

      // Thread-scoped branches are minted client-side; the first editor read
      // materializes them on GitHub from the default head.
      const url = decofileUrl(project, "thread-minted-branch");
      const first = await ctx.get(url);
      expect(first.status()).toBe(200);
      const body = (await first.json()) as DecofileGetBody;
      expect(body.decofile["Hero"]).toEqual({ n: 1 });

      const admin = await inspectStubRepo(ctx, owner, "site");
      expect(admin.refs["thread-minted-branch"]).toBe(admin.refs["main"]);

      // Anonymous (token) reads never create branches: a draft pull of a
      // missing branch must 404 to the published fallback. The token is
      // branch-scoped, so mint one for the missing branch via a session GET
      // of ANOTHER branch and expect the scope mismatch to 401 instead —
      // and a well-scoped token for a still-missing branch cannot exist
      // through the public surface at all.
      const anon = await newApiContext(playwright);
      try {
        const foreign = await anon.get(
          `${decofileUrl(project, "never-touched")}?token=${encodeURIComponent(body.token as string)}`,
        );
        // Token was scoped to "thread-minted-branch", not "never-touched".
        expect(foreign.status()).toBe(401);
      } finally {
        await anon.dispose();
      }
    } finally {
      await ctx.dispose();
    }
  });

  test("404 for unknown virtual MCP and for projects without the Fast Preview gate", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const org = user.orgSlug;

      // Unknown vmcp id.
      const unknown = await ctx.get(
        `/api/${org}/decofile/${randomUUID()}/main`,
      );
      expect(unknown.status()).toBe(404);
      expect(await unknown.json()).toEqual({ error: "Virtual MCP not found" });

      // Existing vmcp, but no fastPreview/productionUrl metadata: gate off.
      const bare = await callSelfMcpTool<{ item: { id: string } }>(
        ctx,
        org,
        "COLLECTION_VIRTUAL_MCP_CREATE",
        { data: { title: `no-gate ${Date.now()}`, connections: [] } },
      );
      const gated = await ctx.get(`/api/${org}/decofile/${bare.item.id}/main`);
      expect(gated.status()).toBe(404);
      expect(await gated.json()).toEqual({
        error: "Fast Preview is not enabled for this project",
      });

      // fastPreview flag alone is inert without a valid production URL.
      const flagOnly = await callSelfMcpTool<{ item: { id: string } }>(
        ctx,
        org,
        "COLLECTION_VIRTUAL_MCP_CREATE",
        {
          data: {
            title: `flag-only ${Date.now()}`,
            metadata: { fastPreview: true },
            connections: [],
          },
        },
      );
      // Legacy `productionUrl` key still satisfies the gate (dual-read): this
      // project has no githubRepo, so passing the gate surfaces the NEXT
      // failure ("no GitHub repository") instead of the gate-off 404.
      const legacyKey = await callSelfMcpTool<{ item: { id: string } }>(
        ctx,
        org,
        "COLLECTION_VIRTUAL_MCP_CREATE",
        {
          data: {
            title: `legacy-key ${Date.now()}`,
            metadata: {
              fastPreview: true,
              productionUrl: "https://legacy.example.com",
            },
            connections: [],
          },
        },
      );
      const legacyRes = await ctx.get(
        `/api/${org}/decofile/${legacyKey.item.id}/main`,
      );
      expect(legacyRes.status()).toBe(404);
      expect(await legacyRes.json()).toEqual({
        error: "Project has no GitHub repository",
      });

      const flagOnlyRes = await ctx.get(
        `/api/${org}/decofile/${flagOnly.item.id}/main`,
      );
      expect(flagOnlyRes.status()).toBe(404);
      expect(await flagOnlyRes.json()).toEqual({
        error: "Fast Preview is not enabled for this project",
      });
    } finally {
      await ctx.dispose();
    }
  });

  test("GET merges blocks (decoded keys), echoes ETag, honors If-None-Match, and enforces token/membership auth", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const anon = await newApiContext(playwright); // cookie-less
    const outsider = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const org = user.orgSlug;
      const owner = uniqueOwner();
      const repo = "site";

      const heroBlock = {
        __resolveType: "site/sections/Hero.tsx",
        title: "Welcome",
      };
      const compreBlock = {
        __resolveType: "site/sections/CompreJunto.tsx",
      };
      await seedStubRepo(ctx, {
        owner,
        repo,
        defaultBranch: "main",
        branches: {
          main: {
            files: {
              // Pretty-printed block: the merge splices raw contents, so the
              // merged document must still parse.
              ".deco/blocks/Hero.json": blockFileContent(heroBlock),
              // Double-encoded stem: the key must decode until stable.
              ".deco/blocks/Compre%2520Junto.json": JSON.stringify(compreBlock),
              // Non-block file: must not leak into the decofile.
              "README.md": "# hi\n",
            },
          },
        },
      });

      const project = await createFastPreviewProject(ctx, org, { owner, repo });
      const url = decofileUrl(project, "main");

      const res = await ctx.get(url);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as DecofileGetBody;
      expect(body.version).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof body.token).toBe("string");
      // The API reports the authority it is reachable on, so the editor can
      // build a draft pointer that works from the native app too.
      expect(body.apiHost).toMatch(/^[\w.-]+(:\d+)?$/);
      expect(body.decofile["Hero"]).toEqual(heroBlock);
      expect(body.decofile["Compre Junto"]).toEqual(compreBlock);
      expect(Object.keys(body.decofile).sort()).toEqual([
        "Compre Junto",
        "Hero",
      ]);
      expect(res.headers()["etag"]).toBe(`"${body.version}"`);

      // Conditional re-read on the same head: 304, no body.
      const cached = await ctx.get(url, {
        headers: { "if-none-match": `"${body.version}"` },
      });
      expect(cached.status()).toBe(304);
      expect((await cached.body()).length).toBe(0);

      // Anonymous without token: 401.
      const noToken = await anon.get(url);
      expect(noToken.status()).toBe(401);

      // Anonymous with the session-issued draft token: 200 with the BARE
      // decofile map — the production runtime JSON-parses the body and
      // snapshots it over the base blocks verbatim, so wrapper keys
      // (version/token) would become bogus "blocks" and blank the draft.
      // The version still travels as the ETag.
      const token = body.token as string;
      const withToken = await anon.get(
        `${url}?token=${encodeURIComponent(token)}`,
      );
      expect(withToken.status()).toBe(200);
      expect(withToken.headers()["etag"]).toBe(`"${body.version}"`);
      const anonBody = (await withToken.json()) as Record<string, unknown>;
      expect(anonBody.version).toBeUndefined();
      expect(anonBody.token).toBeUndefined();
      expect(anonBody["Hero"]).toEqual(heroBlock);

      // A second GET of the same head must be BYTE-identical — the merged
      // document is cached and served as stored bytes, never re-parsed or
      // re-serialized (a serialization drift would break preview-side ETag
      // and content diffing).
      const secondRead = await anon.get(
        `${url}?token=${encodeURIComponent(token)}`,
      );
      expect(secondRead.status()).toBe(200);
      expect((await secondRead.body()).equals(await withToken.body())).toBe(
        true,
      );

      // Anonymous with a garbage token: 401.
      const garbage = await anon.get(`${url}?token=garbage.garbage`);
      expect(garbage.status()).toBe(401);

      // A signed-in NON-member of the org: 403 from resolveOrgFromPath.
      await signUpViaApi(outsider);
      const crossTenant = await outsider.get(url);
      expect(crossTenant.status()).toBe(403);
    } finally {
      await ctx.dispose();
      await anon.dispose();
      await outsider.dispose();
    }
  });

  test("GET drops a block that is not valid JSON instead of returning an unparseable body", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const org = user.orgSlug;
      const owner = uniqueOwner();
      const repo = "site";

      const heroBlock = {
        __resolveType: "site/sections/Hero.tsx",
        title: "Welcome",
      };
      await seedStubRepo(ctx, {
        owner,
        repo,
        defaultBranch: "main",
        branches: {
          main: {
            files: {
              ".deco/blocks/Hero.json": blockFileContent(heroBlock),
              // Raw `.tsx` source spliced in would make the whole body unparseable.
              ".deco/blocks/Broken.json": "import { H } from './x'",
            },
          },
        },
      });

      const project = await createFastPreviewProject(ctx, org, { owner, repo });
      const res = await ctx.get(decofileUrl(project, "main"));

      // 200 with a parseable body — not an unparseable 200 that wedges the editor.
      expect(res.status()).toBe(200);
      const body = (await res.json()) as DecofileGetBody;
      // The valid block survives; the corrupt one is dropped, not merged.
      expect(body.decofile["Hero"]).toEqual(heroBlock);
      expect(Object.keys(body.decofile)).toEqual(["Hero"]);
    } finally {
      await ctx.dispose();
    }
  });

  test("legacy repo children (repoScope.sourceConnectionId) read through the mint path", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const owner = uniqueOwner();
      const repo = "site";
      await seedStubRepo(ctx, {
        owner,
        repo,
        defaultBranch: "main",
        branches: {
          main: { files: { ".deco/blocks/Hero.json": '{"n":1}\n' } },
        },
      });

      const project = await createFastPreviewProject(ctx, user.orgSlug, {
        owner,
        repo,
        repoScopeMode: "legacy-mint",
      });

      const res = await ctx.get(decofileUrl(project, "main"));
      expect(res.status()).toBe(200);
      const body = (await res.json()) as DecofileGetBody;
      expect(body.decofile["Hero"]).toEqual({ n: 1 });
    } finally {
      await ctx.dispose();
    }
  });

  test("cold read of a many-block repo succeeds via the blob fallback (the stub serves no tarballs)", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const owner = uniqueOwner();
      const repo = "site";

      // Above the server's cold-read threshold (50 cache-missing blobs) the
      // API prefers ONE tarball download over per-blob fetches. The stub has
      // no tarball endpoint, so this read exercises the fallback: tarball
      // 404s, the server degrades to bounded per-blob fetches, and the full
      // document still comes back. (The tar-subprocess happy path cannot run
      // against the stub; it is covered by the live smoke against a real
      // repo.) Note the smaller repos in the other tests never cross the
      // threshold, so this is the only test that reaches the tarball branch.
      const blockFor = (i: number): Record<string, unknown> => ({
        __resolveType: `site/sections/Block${i}.tsx`,
        n: i,
      });
      const files: Record<string, string> = {};
      for (let i = 0; i < 60; i++) {
        files[`.deco/blocks/Block${i}.json`] = blockFileContent(blockFor(i));
      }
      await seedStubRepo(ctx, {
        owner,
        repo,
        defaultBranch: "main",
        branches: { main: { files } },
      });
      const project = await createFastPreviewProject(ctx, user.orgSlug, {
        owner,
        repo,
      });

      const res = await ctx.get(decofileUrl(project, "main"));
      expect(res.status()).toBe(200);
      const body = (await res.json()) as DecofileGetBody;
      expect(Object.keys(body.decofile).length).toBe(60);
      expect(body.decofile["Block0"]).toEqual(blockFor(0));
      expect(body.decofile["Block42"]).toEqual(blockFor(42));
      expect(body.decofile["Block59"]).toEqual(blockFor(59));
    } finally {
      await ctx.dispose();
    }
  });

  test("PATCH set lands one pretty-printed commit and moves status drift", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const org = user.orgSlug;
      const owner = uniqueOwner();
      const repo = "site";

      await seedStubRepo(ctx, {
        owner,
        repo,
        defaultBranch: "main",
        branches: {
          main: { files: { ".deco/blocks/Hero.json": '{"title":"old"}' } },
          // No files -> the draft branch aliases the main head (zero drift).
          draft: null,
        },
      });
      const project = await createFastPreviewProject(ctx, org, { owner, repo });
      const url = decofileUrl(project, "draft");

      const before = (await (await ctx.get(url)).json()) as DecofileGetBody;
      const statusBefore = await ctx.get(`${url}/status`);
      expect(statusBefore.status()).toBe(200);
      expect(await statusBefore.json()).toEqual({
        baseBranch: "main",
        aheadBy: 0,
        behindBy: 0,
      });

      const commitsBefore = (await inspectStubRepo(ctx, owner, repo)).commits
        .length;

      const newHero = {
        __resolveType: "site/sections/Hero.tsx",
        title: "Fresh headline",
        cta: { label: "Buy", href: "/checkout" },
      };
      const patchRes = await ctx.patch(url, {
        data: { set: { Hero: newHero } },
      });
      expect(patchRes.status()).toBe(200);
      const patchBody = (await patchRes.json()) as {
        version: string;
        token: string;
      };
      expect(patchBody.version).toMatch(/^[0-9a-f]{40}$/);
      expect(patchBody.version).not.toBe(before.version);
      expect(typeof patchBody.token).toBe("string");

      const inspected = await inspectStubRepo(ctx, owner, repo);
      expect(inspected.commits.length).toBe(commitsBefore + 1);
      const lastCommit = inspected.commits[inspected.commits.length - 1];
      expect(lastCommit?.sha).toBe(patchBody.version);
      expect(lastCommit?.message).toContain("chore(decofile): update Hero");
      expect(inspected.branches["draft"]?.headSha).toBe(patchBody.version);
      expect(inspected.branches["draft"]?.files[".deco/blocks/Hero.json"]).toBe(
        blockFileContent(newHero),
      );
      // main untouched.
      expect(inspected.branches["main"]?.headSha).toBe(before.version);

      // A follow-up read reflects the new head and content.
      const after = (await (await ctx.get(url)).json()) as DecofileGetBody;
      expect(after.version).toBe(patchBody.version);
      expect(after.decofile["Hero"]).toEqual(newHero);

      const statusAfter = await ctx.get(`${url}/status`);
      expect(await statusAfter.json()).toEqual({
        baseBranch: "main",
        aheadBy: 1,
        behindBy: 0,
      });
    } finally {
      await ctx.dispose();
    }
  });

  test("PATCH batches set+delete into one commit and delete removes every alias file", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const org = user.orgSlug;
      const owner = uniqueOwner();
      const repo = "site";

      await seedStubRepo(ctx, {
        owner,
        repo,
        defaultBranch: "main",
        branches: {
          main: { files: {} },
          draft: {
            files: {
              ".deco/blocks/Gone.json": '{"old":true}',
              // Single- and double-encoded twins of the key "A B".
              ".deco/blocks/A%20B.json": '{"variant":"single"}',
              ".deco/blocks/A%2520B.json": '{"variant":"double"}',
            },
          },
        },
      });
      const project = await createFastPreviewProject(ctx, org, { owner, repo });
      const url = decofileUrl(project, "draft");

      const commitsBefore = (await inspectStubRepo(ctx, owner, repo)).commits
        .length;

      // Batch: two sets + one delete must land as ONE commit.
      const banner = { __resolveType: "site/sections/Banner.tsx" };
      const footer = { __resolveType: "site/sections/Footer.tsx" };
      const batchRes = await ctx.patch(url, {
        data: { set: { Banner: banner, Footer: footer }, delete: ["Gone"] },
      });
      expect(batchRes.status()).toBe(200);
      const batchBody = (await batchRes.json()) as { version: string };

      let inspected = await inspectStubRepo(ctx, owner, repo);
      expect(inspected.commits.length).toBe(commitsBefore + 1);
      const batchCommit = inspected.commits[inspected.commits.length - 1];
      expect(batchCommit?.sha).toBe(batchBody.version);
      expect(batchCommit?.message).toContain("update Banner, Footer");
      expect(batchCommit?.message).toContain("delete Gone");
      const filesAfterBatch = inspected.branches["draft"]?.files ?? {};
      expect(filesAfterBatch[".deco/blocks/Banner.json"]).toBe(
        blockFileContent(banner),
      );
      expect(filesAfterBatch[".deco/blocks/Footer.json"]).toBe(
        blockFileContent(footer),
      );
      expect(filesAfterBatch[".deco/blocks/Gone.json"]).toBeUndefined();

      // Deleting "A B" must remove BOTH encoded spellings.
      const deleteRes = await ctx.patch(url, { data: { delete: ["A B"] } });
      expect(deleteRes.status()).toBe(200);

      inspected = await inspectStubRepo(ctx, owner, repo);
      expect(inspected.commits.length).toBe(commitsBefore + 2);
      const filesAfterDelete = inspected.branches["draft"]?.files ?? {};
      expect(filesAfterDelete[".deco/blocks/A%20B.json"]).toBeUndefined();
      expect(filesAfterDelete[".deco/blocks/A%2520B.json"]).toBeUndefined();
      // The unrelated blocks survive.
      expect(filesAfterDelete[".deco/blocks/Banner.json"]).toBe(
        blockFileContent(banner),
      );
    } finally {
      await ctx.dispose();
    }
  });

  test("PATCH rejects unsafe keys, non-object blocks, and empty patches", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const org = user.orgSlug;
      const owner = uniqueOwner();
      const repo = "site";

      await seedStubRepo(ctx, {
        owner,
        repo,
        branches: { main: { files: {} } },
      });
      const project = await createFastPreviewProject(ctx, org, { owner, repo });
      const url = decofileUrl(project, "main");

      const traversal = await ctx.patch(url, {
        data: { set: { "..": { hacked: true } } },
      });
      expect(traversal.status()).toBe(400);
      expect(((await traversal.json()) as { error: string }).error).toContain(
        "Invalid block key",
      );

      const traversalDelete = await ctx.patch(url, {
        data: { delete: ["../../etc/passwd"] },
      });
      expect(traversalDelete.status()).toBe(400);

      const nonObject = await ctx.patch(url, {
        data: { set: { Hero: "just a string" } },
      });
      expect(nonObject.status()).toBe(400);
      expect(((await nonObject.json()) as { error: string }).error).toContain(
        'Block "Hero" must be a JSON object',
      );

      const arrayBlock = await ctx.patch(url, {
        data: { set: { Hero: [1, 2, 3] } },
      });
      expect(arrayBlock.status()).toBe(400);

      const empty = await ctx.patch(url, { data: {} });
      expect(empty.status()).toBe(400);

      // No commit ever landed.
      const inspected = await inspectStubRepo(ctx, owner, repo);
      expect(inspected.commits.length).toBe(1); // the seed commit only
    } finally {
      await ctx.dispose();
    }
  });

  test("publish merges the branch into the default branch, then reports up-to-date", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const org = user.orgSlug;
      const owner = uniqueOwner();
      const repo = "site";

      const promo = { __resolveType: "site/sections/Promo.tsx", off: 30 };
      await seedStubRepo(ctx, {
        owner,
        repo,
        defaultBranch: "main",
        branches: {
          main: { files: { ".deco/blocks/Hero.json": '{"title":"live"}' } },
          draft: {
            files: {
              ".deco/blocks/Hero.json": '{"title":"live"}',
              ".deco/blocks/Promo.json": blockFileContent(promo),
            },
          },
        },
      });
      const project = await createFastPreviewProject(ctx, org, { owner, repo });
      const url = decofileUrl(project, "draft");

      const publishRes = await ctx.post(`${url}/publish`);
      expect(publishRes.status()).toBe(200);
      const publishBody = (await publishRes.json()) as {
        result: string;
        sha?: string;
      };
      expect(publishBody.result).toBe("merged");
      expect(publishBody.sha).toMatch(/^[0-9a-f]{40}$/);

      const inspected = await inspectStubRepo(ctx, owner, repo);
      expect(inspected.branches["main"]?.headSha).toBe(publishBody.sha);
      expect(inspected.branches["main"]?.files[".deco/blocks/Promo.json"]).toBe(
        blockFileContent(promo),
      );

      // Publishing again with nothing new: up-to-date, no merge commit.
      const again = await ctx.post(`${url}/publish`);
      expect(again.status()).toBe(200);
      expect(await again.json()).toEqual({ result: "up-to-date" });
    } finally {
      await ctx.dispose();
    }
  });

  test("publish surfaces a merge conflict as 409", async ({ playwright }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const org = user.orgSlug;
      const owner = uniqueOwner();
      const repo = "site";

      await seedStubRepo(ctx, {
        owner,
        repo,
        defaultBranch: "main",
        mergeMode: "conflict",
        branches: {
          main: { files: { ".deco/blocks/Hero.json": '{"title":"live"}' } },
          draft: {
            files: { ".deco/blocks/Hero.json": '{"title":"draft"}' },
          },
        },
      });
      const project = await createFastPreviewProject(ctx, org, { owner, repo });

      const publishRes = await ctx.post(
        `${decofileUrl(project, "draft")}/publish`,
      );
      expect(publishRes.status()).toBe(409);
      expect(await publishRes.json()).toEqual({ error: "merge-conflict" });
    } finally {
      await ctx.dispose();
    }
  });
});
