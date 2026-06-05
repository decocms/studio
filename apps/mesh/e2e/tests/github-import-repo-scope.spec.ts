/**
 * End-to-end tests for per-agent repo-scoped GitHub connections.
 *
 * Feature under test (Tasks 1-6): an imported GitHub agent gets a dedicated
 * child `mcp-github` connection whose `metadata.repoScope` recipe drives
 * on-demand minting of a short-lived, repo-scoped GitHub token via the ORG
 * connection's `MINT_REPO_TOKEN` tool. Deleting the agent tears the child
 * connection (and its minted token) down.
 *
 * Scenarios covered here:
 *   1. Cross-tenant guard — org B cannot read org A's connection through
 *      GITHUB_LIST_USER_ORGS (the guard throws "Connection not found" before
 *      any token read / GitHub call).
 *   2. Teardown FK-ordering — deleting the agent removes the child connection,
 *      its connection_aggregations rows, and (when seeded) its downstream
 *      token, WITHOUT tripping the ON DELETE RESTRICT FK (the agent is deleted
 *      first, clearing the aggregation rows, then the child).
 *   3. Runtime mint-on-demand — calling a tool on a repo-scoped child through
 *      the proxy mints a token via the org connection's MINT_REPO_TOKEN and
 *      caches it in downstream_tokens.
 *
 * OUT OF SCOPE (not attempted here): driving the full GitHub repo-picker UI
 * import. That needs real GitHub OAuth + a live `/user/installations` listing,
 * neither of which is reproducible in a hermetic Playwright run. The runtime
 * behavior the picker depends on (mint, teardown, cross-tenant guard) is
 * exercised directly against the built-in tools instead.
 */

import { z } from "zod";
import { signUpViaApi } from "../fixtures/auth-api";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";
import {
  startTestMcpServer,
  type TestMcpServer,
} from "../fixtures/test-mcp-server";
import { expect, newApiContext, test } from "../fixtures/test";

test.describe("GitHub import repo-scoped connections", () => {
  /**
   * Scenario 1 — cross-tenant guard.
   *
   * The simplest, no-stub case: GITHUB_LIST_USER_ORGS confirms the named
   * connection belongs to the caller's org before reading its token. Org B
   * passing org A's connectionId must fail with "Connection not found" — the
   * guard fires before any GitHub network call, so no token/stub is needed.
   *
   * `callSelfMcpTool` throws on tool error (it inspects `result.isError` and
   * re-throws the first text-content block), so we assert via `rejects`.
   */
  test("GITHUB_LIST_USER_ORGS rejects a connectionId from another org", async ({
    playwright,
  }) => {
    // User A: signs up and owns a connection.
    const ctxA = await newApiContext(playwright);
    // User B: a separate principal in a separate org.
    const ctxB = await newApiContext(playwright);
    try {
      const userA = await signUpViaApi(ctxA);
      const connA = await createHttpConnection(ctxA, userA.orgSlug, {
        title: `Org A conn ${Date.now()}`,
        url: "https://example.com/mcp",
      });

      const userB = await signUpViaApi(ctxB);

      // Org B cannot read org A's connection — the ownership guard throws
      // "Connection not found" before any token read or GitHub call.
      await expect(
        callSelfMcpTool(ctxB, userB.orgSlug, "GITHUB_LIST_USER_ORGS", {
          connectionId: connA.id,
        }),
      ).rejects.toThrow(/Connection not found/);
    } finally {
      await ctxA.dispose();
      await ctxB.dispose();
    }
  });

  /**
   * Scenario 2 — teardown removes the child connection + token.
   *
   * Validates the Critical FK-ordering fix in COLLECTION_VIRTUAL_MCP_DELETE:
   * the agent is deleted FIRST (clearing the ON DELETE RESTRICT
   * connection_aggregations rows that reference the child), THEN the child
   * connection is deleted (its downstream_tokens cascade). Without the
   * ordering fix, deleting the child first would throw a foreign-key
   * violation and make the agent undeletable.
   *
   * We DO seed a downstream_tokens row so the cascade is asserted. Per the
   * task note this makes teardown's best-effort revoke fire one
   * fast-failing, swallowed request to api.github.com with a dummy token —
   * acceptable; the delete must still succeed regardless.
   */
  test("deleting the agent tears down the repo-scoped child connection + token", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const user = await signUpViaApi(ctx);
    const org = user.orgSlug;

    // An org connection to reference as the mint source. Its reachability
    // doesn't matter for teardown (no mint happens during delete).
    const orgConn = await createHttpConnection(ctx, org, {
      title: `Org GitHub ${Date.now()}`,
      url: "https://example.com/mcp",
    });

    // The per-agent repo-scoped child connection. app_name "mcp-github" +
    // metadata.repoScope mark it as a disposable child (getRepoScope must
    // return truthy for teardown to delete it).
    const child = await callSelfMcpTool<{ item: { id: string } }>(
      ctx,
      org,
      "COLLECTION_CONNECTIONS_CREATE",
      {
        data: {
          title: `GitHub: acme/widget ${Date.now()}`,
          app_name: "mcp-github",
          connection_type: "HTTP",
          connection_url: "https://example.com/mcp",
          metadata: {
            repoScope: {
              sourceConnectionId: orgConn.id,
              installationId: 1,
              owner: "acme",
              repo: "widget",
              permissions: { contents: "write" },
            },
          },
        },
      },
    );
    const childId = child.item.id;
    expect(childId).toBeTruthy();

    // The agent, wired to the child connection. metadata.githubRepo.connectionId
    // is what the delete handler reads to find the child to tear down.
    const agent = await callSelfMcpTool<{ item: { id: string } }>(
      ctx,
      org,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: `widget ${Date.now()}`,
          metadata: {
            githubRepo: {
              owner: "acme",
              name: "widget",
              url: "https://github.com/acme/widget",
              installationId: 1,
              connectionId: childId,
            },
          },
          connections: [{ connection_id: childId }],
        },
      },
    );
    const agentId = agent.item.id;
    expect(agentId).toBeTruthy();

    // Seed a downstream token for the child so the cascade-on-delete is
    // observable. The dummy token triggers a swallowed best-effort revoke
    // against api.github.com during teardown — that must not fail the delete.
    const tokenRes = await ctx.post(
      `/api/${org}/connections/${childId}/oauth-token`,
      {
        data: { accessToken: "ghs_e2e_dummy", expiresIn: 3600 },
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(tokenRes.ok()).toBe(true);

    const db = await connectDevDb();
    try {
      // Sanity: the seeded rows exist before deletion.
      const beforeAgg = await db.query(
        "SELECT 1 FROM connection_aggregations WHERE child_connection_id = $1",
        [childId],
      );
      expect(beforeAgg.rowCount).toBeGreaterThan(0);
      const beforeTok = await db.query(
        'SELECT 1 FROM downstream_tokens WHERE "connectionId" = $1',
        [childId],
      );
      expect(beforeTok.rowCount).toBeGreaterThan(0);

      // The delete MUST succeed. Without the FK-ordering fix this throws a
      // foreign-key violation (child deleted before its aggregation rows).
      await callSelfMcpTool(ctx, org, "COLLECTION_VIRTUAL_MCP_DELETE", {
        id: agentId,
      });

      // The agent connection row is gone.
      const agentRow = await db.query(
        "SELECT 1 FROM connections WHERE id = $1",
        [agentId],
      );
      expect(agentRow.rowCount).toBe(0);

      // The child connection row is gone.
      const childRow = await db.query(
        "SELECT 1 FROM connections WHERE id = $1",
        [childId],
      );
      expect(childRow.rowCount).toBe(0);

      // Its aggregation rows are gone (cascade off the parent delete).
      const aggRows = await db.query(
        "SELECT 1 FROM connection_aggregations WHERE child_connection_id = $1 OR parent_connection_id = $1",
        [childId],
      );
      expect(aggRows.rowCount).toBe(0);

      // Its downstream token is gone (cascade off the child connection delete).
      const tokRows = await db.query(
        'SELECT 1 FROM downstream_tokens WHERE "connectionId" = $1',
        [childId],
      );
      expect(tokRows.rowCount).toBe(0);
    } finally {
      await db.end();
      await ctx.dispose();
    }
  });

  /**
   * Scenario 3 — runtime mint-on-demand.
   *
   * Calling any tool on a repo-scoped child through the proxy triggers the
   * outbound header builder → ensureRepoScopedToken → mintRepoToken, which
   * opens an MCP client to the ORG connection and calls MINT_REPO_TOKEN. The
   * minted token is then cached (vault-encrypted) in downstream_tokens.
   *
   * Two stubs: `orgStub` exposes MINT_REPO_TOKEN (with an outputSchema so the
   * SDK emits the structuredContent the mesh mint caller reads), `repoStub`
   * exposes a trivial `whoami` tool the child surfaces.
   *
   * Assertions: orgStub recorded a tools/call naming MINT_REPO_TOKEN, AND a
   * downstream_tokens row now exists for the child with expiresAt set. The
   * stored access token is vault-encrypted, so we assert existence rather than
   * matching plaintext.
   */
  test("calling a repo-scoped child tool mints + caches a token via the org connection", async ({
    playwright,
  }) => {
    let orgStub: TestMcpServer | undefined;
    let repoStub: TestMcpServer | undefined;
    const ctx = await newApiContext(playwright);
    const db = await connectDevDb();
    try {
      orgStub = await startTestMcpServer({
        tools: [
          {
            name: "MINT_REPO_TOKEN",
            description: "Mint a repo-scoped GitHub App installation token.",
            inputSchema: {
              installationId: z.number(),
              owner: z.string(),
              repo: z.string(),
              permissions: z.record(z.string(), z.string()).optional(),
            },
            // outputSchema is required for the SDK to emit structuredContent,
            // which mintRepoToken reads (res.structuredContent.token).
            outputSchema: {
              token: z.string(),
              expiresAt: z.string(),
              permissions: z.record(z.string(), z.string()),
              repository: z.object({ owner: z.string(), name: z.string() }),
              installationId: z.number(),
            },
            handler: () => ({
              token: "ghs_minted_e2e",
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              permissions: {},
              repository: { owner: "acme", name: "widget" },
              installationId: 1,
            }),
          },
        ],
      });

      repoStub = await startTestMcpServer({
        tools: [
          {
            name: "whoami",
            description: "Trivial tool exposed by the repo-scoped child.",
            handler: () => ({ ok: true }),
          },
        ],
      });

      const user = await signUpViaApi(ctx);
      const org = user.orgSlug;

      // Org connection: the mint source. Points at orgStub so MINT_REPO_TOKEN
      // resolves to a reachable tool.
      const orgConn = await createHttpConnection(ctx, org, {
        title: `Org GitHub ${Date.now()}`,
        url: orgStub.url,
      });

      // Repo-scoped child: points at repoStub, carries the mint recipe, and has
      // NO downstream token yet (so the first proxied call must mint).
      const child = await callSelfMcpTool<{ item: { id: string } }>(
        ctx,
        org,
        "COLLECTION_CONNECTIONS_CREATE",
        {
          data: {
            title: `GitHub: acme/widget ${Date.now()}`,
            app_name: "mcp-github",
            connection_type: "HTTP",
            connection_url: repoStub.url,
            metadata: {
              repoScope: {
                sourceConnectionId: orgConn.id,
                installationId: 1,
                owner: "acme",
                repo: "widget",
                permissions: { contents: "write" },
              },
            },
          },
        },
      );
      const childId = child.item.id;
      expect(childId).toBeTruthy();

      // No token before the first proxied call.
      const before = await db.query(
        'SELECT 1 FROM downstream_tokens WHERE "connectionId" = $1',
        [childId],
      );
      expect(before.rowCount).toBe(0);

      // Hit the proxy for the child connection. The outbound header builder
      // runs per request and mints the repo-scoped token on the way out.
      const res = await ctx.post(`/api/${org}/mcp/${childId}`, {
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "whoami", arguments: {} },
        },
        headers: { Accept: "application/json, text/event-stream" },
      });
      expect(res.ok()).toBe(true);
      const envelope = (await res.json()) as {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
        error?: unknown;
      };
      expect(envelope.error).toBeUndefined();
      expect(envelope.result?.isError).not.toBe(true);

      // The org stub must have been asked to mint.
      const mintCall = orgStub.requests.some(
        (r) =>
          r.method === "tools/call" &&
          typeof r.body === "object" &&
          r.body !== null &&
          (r.body as { params?: { name?: string } }).params?.name ===
            "MINT_REPO_TOKEN",
      );
      expect(mintCall).toBe(true);

      // The minted token is now cached (vault-encrypted) with an expiry set.
      const after = await db.query<{ expiresAt: string | null }>(
        'SELECT "expiresAt" FROM downstream_tokens WHERE "connectionId" = $1',
        [childId],
      );
      expect(after.rowCount).toBe(1);
      expect(after.rows[0]?.expiresAt).toBeTruthy();
    } finally {
      await db.end();
      await ctx.dispose();
      await orgStub?.stop();
      await repoStub?.stop();
    }
  });
});
