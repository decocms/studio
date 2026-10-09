/**
 * E2E: entering a project resumes the user's last chat there, even when that
 * chat is older than a page of their chats in other projects.
 *
 * The shared thread feed holds only the user's latest page across the org.
 * Entry used to resolve against that page alone, so a repo-backed project's
 * last draft dropped out of reach and entry minted another draft beside it
 * (and a branchless project opened an empty composer instead of its last chat).
 *
 * Wire-contract strings (paths, search keys) are inlined by hand on purpose —
 * this suite owns its contract and imports no app code (see
 * `plugins/ban-e2e-app-imports.js`).
 */

import type { APIRequestContext } from "@playwright/test";
import { connectDevDb } from "../fixtures/db";
import {
  callSelfMcpTool,
  createHttpConnection,
  findOrgId,
} from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

/** Cold-Vite route compiles can take a minute+ on a loaded box. */
const SHELL_TIMEOUT_MS = 90_000;

/** More than one page of the shared thread feed. */
const NEWER_THREADS_ELSEWHERE = 11;

async function createProject(
  request: APIRequestContext,
  orgSlug: string,
  title: string,
  options?: { repository?: boolean },
): Promise<string> {
  const connection = await createHttpConnection(request, orgSlug, {
    title: `${title} placeholder`,
    url: "http://127.0.0.1:1/unused",
  });
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    request,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title,
        status: "active",
        pinned: false,
        connections: [{ connection_id: connection.id }],
        ...(options?.repository
          ? {
              metadata: {
                repository: {
                  url: "https://github.com/example/repo",
                  owner: "example",
                  name: "repo",
                  connectionId: connection.id,
                },
              },
            }
          : {}),
      },
    },
  );
  return agent.item.id;
}

async function createThread(
  request: APIRequestContext,
  orgSlug: string,
  virtualMcpId: string,
): Promise<string> {
  const thread = await callSelfMcpTool<{ item: { id: string } }>(
    request,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    { data: { virtual_mcp_id: virtualMcpId } },
  );
  return thread.item.id;
}

async function countProjectThreads(
  orgId: string,
  virtualMcpId: string,
): Promise<number> {
  const db = await connectDevDb();
  try {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM threads
        WHERE organization_id = $1 AND virtual_mcp_id = $2`,
      [orgId, virtualMcpId],
    );
    return Number(rows[0]?.count ?? "-1");
  } finally {
    await db.end();
  }
}

test.describe("project entry thread", () => {
  test.describe.configure({ timeout: 240_000 });

  for (const { kind, repository } of [
    { kind: "repo-backed", repository: true },
    { kind: "branchless", repository: false },
  ] as const) {
    test(`a ${kind} project resumes its last chat past the shared feed's first page`, async ({
      authedPage: { page, orgSlug },
    }) => {
      const request = page.context().request;
      const orgId = await findOrgId(request, orgSlug);
      const projectId = await createProject(
        request,
        orgSlug,
        `entry ${kind} e2e`,
        { repository },
      );
      const lastThreadId = await createThread(request, orgSlug, projectId);

      const elsewhereId = await createProject(
        request,
        orgSlug,
        `entry ${kind} elsewhere e2e`,
      );
      for (let i = 0; i < NEWER_THREADS_ELSEWHERE; i++) {
        await createThread(request, orgSlug, elsewhereId);
      }

      await page.goto(`/${orgSlug}/projects/${projectId}`);
      await page.waitForURL(
        (url) =>
          url.pathname === `/${orgSlug}/projects/${projectId}` &&
          url.searchParams.get("thread") === lastThreadId,
        { timeout: SHELL_TIMEOUT_MS },
      );
      expect(await countProjectThreads(orgId, projectId)).toBe(1);
    });
  }
});
