/**
 * Wiring for sandbox-less Fast Preview projects, shared by the specs that
 * exercise them (`decofile-api`, `fast-preview-git-sync`).
 *
 * All GitHub traffic lands on the local Git Data stub (`github-stub.ts`, wired
 * via GITHUB_API_BASE_URL in the Playwright config) — nothing reaches
 * api.github.com. The GitHub token mint is short-circuited by pre-seeding an
 * unexpired downstream token on the repo-scoped child connection.
 */

import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { callSelfMcpTool, createHttpConnection } from "./mcp-tools";
import { expect } from "./test";

const GITHUB_STUB_ORIGIN = `http://localhost:${process.env.GITHUB_STUB_PORT ?? "4102"}`;

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

/** Flip merge behavior on a seeded repo without re-seeding its history. */
export async function setStubMergeMode(
  ctx: APIRequestContext,
  owner: string,
  repo: string,
  mergeMode: "merge" | "conflict" | "blocked",
): Promise<void> {
  const res = await ctx.post(
    `${GITHUB_STUB_ORIGIN}/__admin/repos/${owner}/${repo}/config`,
    { data: { mergeMode } },
  );
  expect(res.ok()).toBe(true);
}

export interface FastPreviewProject {
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
export async function createFastPreviewProject(
  ctx: APIRequestContext,
  org: string,
  params: {
    owner: string;
    repo: string;
    repoScopeMode?: "refreshable" | "legacy-mint";
    /**
     * MCP endpoint the repo child connection advertises. HTTP-only specs never
     * dial it (the git surfaces go through `metadata.repoScope` + the vault
     * token), but a BROWSER spec does: the header's PR lookup opens an MCP
     * client against this connection on mount. Point it at a closed local port
     * so that handshake fails immediately instead of leaving the suite waiting
     * on an outbound connection to a real host.
     */
    connectionUrl?: string;
  },
): Promise<FastPreviewProject> {
  const {
    owner,
    repo,
    repoScopeMode = "refreshable",
    connectionUrl = "https://example.com/mcp",
  } = params;

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
        connection_url: connectionUrl,
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
export const uniqueOwner = (): string => `e2e-${randomUUID().slice(0, 12)}`;
