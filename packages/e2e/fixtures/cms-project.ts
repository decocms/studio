/**
 * Shared wiring for a CMS-mode ("Fast Preview") project, plus the GitHub Git
 * Data stub admin calls its specs need.
 *
 * Promoted out of decofile-api.spec.ts once a second suite needed it. Every
 * GitHub call lands on the local stub (fixtures/github-stub.ts, wired via
 * GITHUB_API_BASE_URL in the Playwright config) — nothing reaches api.github.com.
 */

import type { APIRequestContext } from "@playwright/test";
import { expect } from "./test";
import { callSelfMcpTool, createHttpConnection } from "./mcp-tools";

export const GITHUB_STUB_ORIGIN = `http://localhost:${process.env.GITHUB_STUB_PORT ?? "4102"}`;

export interface StubRepoInspection {
  defaultBranch: string;
  mergeMode: string;
  refs: Record<string, string>;
  commits: Array<{ sha: string; message: string; parents: string[] }>;
  branches: Record<string, { headSha: string; files: Record<string, string> }>;
}

export async function seedStubRepo(
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

export async function inspectStubRepo(
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

/** Unique owner per test run keeps the stub's repo namespace parallel-safe. */
export const uniqueOwner = (): string =>
  `e2e-${crypto.randomUUID().slice(0, 12)}`;

export interface CmsProject {
  org: string;
  owner: string;
  repo: string;
  vmcpId: string;
  childConnectionId: string;
}

/**
 * Full CMS-mode project wiring: repo-scoped GitHub child + unexpired
 * downstream token + a virtual MCP carrying the CMS-mode gate.
 */
export async function createCmsProject(
  ctx: APIRequestContext,
  org: string,
  params: {
    owner: string;
    repo: string;
    repoScopeMode?: "refreshable" | "legacy-mint";
  },
): Promise<CmsProject> {
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
