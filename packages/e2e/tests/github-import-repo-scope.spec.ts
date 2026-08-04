/**
 * End-to-end tests for per-agent repo-scoped GitHub connections.
 *
 * Feature under test (Tasks 1-6): an imported GitHub agent gets a dedicated
 * child `mcp-github` connection whose `metadata.repoScope` marks it as
 * repo-scoped. Legacy children can mint a short-lived token through an ORG
 * connection; refreshable children carry no sourceConnectionId and refresh
 * their repo grant through the normal downstream_tokens OAuth path.
 *
 * Scenarios covered here:
 *   1. Cross-tenant guard — org B cannot read org A's connection through
 *      GITHUB_LIST_USER_ORGS (the guard throws "Connection not found" before
 *      any token read / GitHub call).
 *   2. Teardown FK-ordering — deleting the agent removes the child connection,
 *      its connection_aggregations rows, and (when seeded) its downstream
 *      token, WITHOUT tripping the ON DELETE RESTRICT FK (the agent is deleted
 *      first, clearing the aggregation rows, then the child).
 *   3. Runtime refresh — calling a tool on a source-less repo-scoped child
 *      refreshes its repo grant through downstream_tokens without using the
 *      org connection.
 *
 * OUT OF SCOPE (not attempted here): driving the full GitHub repo-picker UI
 * import. That needs real GitHub OAuth + a live `/user/installations` listing,
 * neither of which is reproducible in a hermetic Playwright run. The runtime
 * behavior the picker depends on (mint, teardown, cross-tenant guard) is
 * exercised directly against the built-in tools instead.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { APIRequestContext } from "@playwright/test";
import { signUpViaApi } from "../fixtures/auth-api";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";
import {
  startTestMcpServer,
  type TestMcpServer,
} from "../fixtures/test-mcp-server";
import { expect, newApiContext, test } from "../fixtures/test";

interface TokenEndpointRequest {
  method: string;
  body: Record<string, string>;
  timestamp: number;
}

interface TokenEndpointConfig {
  status?: number;
  body?: Record<string, unknown>;
}

interface TestTokenEndpoint {
  url: string;
  requests: ReadonlyArray<TokenEndpointRequest>;
  stop: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function startTokenEndpoint(
  config: TokenEndpointConfig = {},
): Promise<TestTokenEndpoint> {
  const status = config.status ?? 200;
  const body = config.body ?? {
    access_token: "ghs_refreshed_e2e",
    refresh_token: "repo_grant_e2e_rotated",
    expires_in: 3600,
    scope: "repo:acme/widget",
  };
  const recorded: TokenEndpointRequest[] = [];

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const raw = req.method === "POST" ? await readBody(req) : "";
        recorded.push({
          method: req.method ?? "UNKNOWN",
          body: Object.fromEntries(new URLSearchParams(raw)),
          timestamp: Date.now(),
        });

        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(body));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : "request failed",
          }),
        );
      }
    },
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Token endpoint did not bind to a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/token`,
    requests: recorded,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function createRepoGrantChild(
  ctx: APIRequestContext,
  org: string,
  connectionUrl: string,
): Promise<string> {
  const child = await callSelfMcpTool<{ item: { id: string } }>(
    ctx,
    org,
    "COLLECTION_CONNECTIONS_CREATE",
    {
      data: {
        title: `GitHub: acme/widget ${Date.now()}`,
        app_name: "mcp-github",
        connection_type: "HTTP",
        connection_url: connectionUrl,
        metadata: {
          repoScope: {
            installationId: 1,
            repositoryId: 99,
            owner: "acme",
            repo: "widget",
            permissions: { contents: "write" },
            grantProvider: "github-mcp",
          },
        },
      },
    },
  );
  expect(child.item.id).toBeTruthy();
  return child.item.id;
}

async function seedExpiredRepoGrantToken(
  ctx: APIRequestContext,
  org: string,
  childId: string,
  tokenEndpoint: string,
): Promise<void> {
  const tokenRes = await ctx.post(
    `/api/${org}/connections/${childId}/oauth-token`,
    {
      data: {
        accessToken: "ghs_expired_e2e",
        refreshToken: "repo_grant_e2e",
        expiresIn: -60,
        clientId: "github-mcp",
        tokenEndpoint,
      },
      headers: { "Content-Type": "application/json" },
    },
  );
  expect(tokenRes.ok()).toBe(true);
}

async function callRepoChildWhoami(
  ctx: APIRequestContext,
  org: string,
  childId: string,
): Promise<void> {
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
}

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

  test("GITHUB_LIST_USER_ORGS rejects repo-scoped child connections", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const org = user.orgSlug;

      const orgConn = await createHttpConnection(ctx, org, {
        title: `Org GitHub ${Date.now()}`,
        url: "https://example.com/mcp",
      });

      const child = await callSelfMcpTool<{ item: { id: string } }>(
        ctx,
        org,
        "COLLECTION_CONNECTIONS_CREATE",
        {
          data: {
            title: `GitHub: deco-sites/demo ${Date.now()}`,
            app_name: "mcp-github",
            connection_type: "HTTP",
            connection_url: "https://example.com/mcp",
            metadata: {
              repoScope: {
                sourceConnectionId: orgConn.id,
                installationId: 1,
                owner: "deco-sites",
                repo: "demo",
                permissions: { contents: "write" },
              },
            },
          },
        },
      );

      await expect(
        callSelfMcpTool(ctx, org, "GITHUB_LIST_USER_ORGS", {
          connectionId: child.item.id,
        }),
      ).rejects.toThrow(/Repo-scoped connections cannot list installations/);
    } finally {
      await ctx.dispose();
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
   * Scenario 2b — a repo connection someone else holds survives the teardown.
   *
   * Import reuses an existing connection when the org already has that
   * repository, so "the child belongs to this agent" no longer holds. Two ways
   * it can be someone else's:
   *   - `metadata.orgShared` — the org's own "Add repo" connection;
   *   - still aggregated by another agent after this one is deleted.
   *
   * Both must survive WITH their token: the revoke used to run before the
   * delete, so relying on the ON DELETE RESTRICT FK to block the delete would
   * still leave a live connection holding a revoked grant.
   */
  test("deleting an agent keeps an org-shared repo connection and its token", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const user = await signUpViaApi(ctx);
    const org = user.orgSlug;

    const orgConn = await createHttpConnection(ctx, org, {
      title: `Org GitHub ${Date.now()}`,
      url: "https://example.com/mcp",
    });

    // The org's shared repo connection — "Add repo", not owned by any agent.
    const shared = await callSelfMcpTool<{ item: { id: string } }>(
      ctx,
      org,
      "COLLECTION_CONNECTIONS_CREATE",
      {
        data: {
          title: `GitHub: acme/shared ${Date.now()}`,
          app_name: "mcp-github",
          connection_type: "HTTP",
          connection_url: "https://example.com/mcp",
          metadata: {
            orgShared: true,
            repoScope: {
              sourceConnectionId: orgConn.id,
              installationId: 1,
              owner: "acme",
              repo: "shared",
              permissions: { contents: "write" },
            },
          },
        },
      },
    );
    const sharedId = shared.item.id;

    const agent = await callSelfMcpTool<{ item: { id: string } }>(
      ctx,
      org,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: `shared-consumer ${Date.now()}`,
          metadata: {
            githubRepo: {
              owner: "acme",
              name: "shared",
              url: "https://github.com/acme/shared",
              installationId: 1,
              connectionId: sharedId,
            },
          },
          connections: [{ connection_id: sharedId }],
        },
      },
    );

    const tokenRes = await ctx.post(
      `/api/${org}/connections/${sharedId}/oauth-token`,
      {
        data: { accessToken: "ghs_e2e_dummy", expiresIn: 3600 },
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(tokenRes.ok()).toBe(true);

    const db = await connectDevDb();
    try {
      await callSelfMcpTool(ctx, org, "COLLECTION_VIRTUAL_MCP_DELETE", {
        id: agent.item.id,
      });

      // The agent is gone...
      const agentRow = await db.query(
        "SELECT 1 FROM connections WHERE id = $1",
        [agent.item.id],
      );
      expect(agentRow.rowCount).toBe(0);

      // ...but the org keeps its repo, token included.
      const sharedRow = await db.query(
        "SELECT 1 FROM connections WHERE id = $1",
        [sharedId],
      );
      expect(sharedRow.rowCount).toBe(1);
      const tokRows = await db.query(
        'SELECT 1 FROM downstream_tokens WHERE "connectionId" = $1',
        [sharedId],
      );
      expect(tokRows.rowCount).toBe(1);
    } finally {
      await db.end();
      await ctx.dispose();
    }
  });

  test("deleting one agent keeps a repo connection another agent still aggregates", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const user = await signUpViaApi(ctx);
    const org = user.orgSlug;

    const orgConn = await createHttpConnection(ctx, org, {
      title: `Org GitHub ${Date.now()}`,
      url: "https://example.com/mcp",
    });

    // NOT org-shared: a plain repo child, but two agents were imported against
    // the same repository, so both list it.
    const child = await callSelfMcpTool<{ item: { id: string } }>(
      ctx,
      org,
      "COLLECTION_CONNECTIONS_CREATE",
      {
        data: {
          title: `GitHub: acme/two-agents ${Date.now()}`,
          app_name: "mcp-github",
          connection_type: "HTTP",
          connection_url: "https://example.com/mcp",
          metadata: {
            repoScope: {
              sourceConnectionId: orgConn.id,
              installationId: 1,
              owner: "acme",
              repo: "two-agents",
              permissions: { contents: "write" },
            },
          },
        },
      },
    );
    const childId = child.item.id;

    const makeAgent = (label: string) =>
      callSelfMcpTool<{ item: { id: string } }>(
        ctx,
        org,
        "COLLECTION_VIRTUAL_MCP_CREATE",
        {
          data: {
            title: `${label} ${Date.now()}`,
            metadata: {
              githubRepo: {
                owner: "acme",
                name: "two-agents",
                url: "https://github.com/acme/two-agents",
                installationId: 1,
                connectionId: childId,
              },
            },
            connections: [{ connection_id: childId }],
          },
        },
      );
    const first = await makeAgent("first");
    const second = await makeAgent("second");

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
      await callSelfMcpTool(ctx, org, "COLLECTION_VIRTUAL_MCP_DELETE", {
        id: first.item.id,
      });

      // The second agent still holds the repo — connection and token intact.
      const childRow = await db.query(
        "SELECT 1 FROM connections WHERE id = $1",
        [childId],
      );
      expect(childRow.rowCount).toBe(1);
      const tokRows = await db.query(
        'SELECT 1 FROM downstream_tokens WHERE "connectionId" = $1',
        [childId],
      );
      expect(tokRows.rowCount).toBe(1);
      const aggRows = await db.query(
        "SELECT 1 FROM connection_aggregations WHERE child_connection_id = $1",
        [childId],
      );
      expect(aggRows.rowCount).toBe(1);

      // Deleting the LAST holder does tear it down — the rule is "someone else
      // holds it", not "never delete".
      await callSelfMcpTool(ctx, org, "COLLECTION_VIRTUAL_MCP_DELETE", {
        id: second.item.id,
      });
      const goneRow = await db.query(
        "SELECT 1 FROM connections WHERE id = $1",
        [childId],
      );
      expect(goneRow.rowCount).toBe(0);
    } finally {
      await db.end();
      await ctx.dispose();
    }
  });

  /**
   * Scenario 3 — runtime refresh of a repo grant.
   *
   * A source-less repo-scoped child has no org-parent soft link. Calling a tool
   * through the proxy should refresh the expired repo grant via the stored
   * OAuth-shaped downstream token fields, not call MINT_REPO_TOKEN.
   */
  test("calling a repo-scoped child tool refreshes a repo grant without using the org connection", async ({
    playwright,
  }) => {
    let repoStub: TestMcpServer | undefined;
    let tokenEndpoint: TestTokenEndpoint | undefined;
    const ctx = await newApiContext(playwright);
    const db = await connectDevDb();
    try {
      tokenEndpoint = await startTokenEndpoint();
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

      const childId = await createRepoGrantChild(ctx, org, repoStub.url);
      await seedExpiredRepoGrantToken(ctx, org, childId, tokenEndpoint.url);

      await callRepoChildWhoami(ctx, org, childId);

      expect(tokenEndpoint.requests).toHaveLength(1);
      expect(tokenEndpoint.requests[0]?.body).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: "repo_grant_e2e",
        client_id: "github-mcp",
      });

      // The refreshed token is cached (vault-encrypted) with an expiry set.
      const after = await db.query<{ expiresAt: string | null }>(
        'SELECT "expiresAt" FROM downstream_tokens WHERE "connectionId" = $1',
        [childId],
      );
      expect(after.rowCount).toBe(1);
      expect(after.rows[0]?.expiresAt).toBeTruthy();
    } finally {
      await Promise.allSettled([
        db.end(),
        ctx.dispose(),
        tokenEndpoint?.stop(),
        repoStub?.stop(),
      ]);
    }
  });

  test("permanently invalid repo grant refresh deletes the cached downstream token", async ({
    playwright,
  }) => {
    let repoStub: TestMcpServer | undefined;
    let tokenEndpoint: TestTokenEndpoint | undefined;
    const ctx = await newApiContext(playwright);
    const db = await connectDevDb();
    try {
      tokenEndpoint = await startTokenEndpoint({
        status: 400,
        body: { error: "invalid_grant", error_description: "grant revoked" },
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
      const childId = await createRepoGrantChild(ctx, org, repoStub.url);
      await seedExpiredRepoGrantToken(ctx, org, childId, tokenEndpoint.url);

      await callRepoChildWhoami(ctx, org, childId);

      expect(tokenEndpoint.requests.length).toBeGreaterThan(0);
      for (const request of tokenEndpoint.requests) {
        expect(request.body).toMatchObject({
          grant_type: "refresh_token",
          refresh_token: "repo_grant_e2e",
          client_id: "github-mcp",
        });
      }
      const after = await db.query(
        'SELECT 1 FROM downstream_tokens WHERE "connectionId" = $1',
        [childId],
      );
      expect(after.rowCount).toBe(0);
    } finally {
      await Promise.allSettled([
        db.end(),
        ctx.dispose(),
        tokenEndpoint?.stop(),
        repoStub?.stop(),
      ]);
    }
  });

  test("transient repo grant refresh failure keeps the cached downstream token", async ({
    playwright,
  }) => {
    let repoStub: TestMcpServer | undefined;
    let tokenEndpoint: TestTokenEndpoint | undefined;
    const ctx = await newApiContext(playwright);
    const db = await connectDevDb();
    try {
      tokenEndpoint = await startTokenEndpoint({
        status: 503,
        body: { error: "server_error" },
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
      const childId = await createRepoGrantChild(ctx, org, repoStub.url);
      await seedExpiredRepoGrantToken(ctx, org, childId, tokenEndpoint.url);

      await callRepoChildWhoami(ctx, org, childId);

      expect(tokenEndpoint.requests.length).toBeGreaterThan(0);
      for (const request of tokenEndpoint.requests) {
        expect(request.body).toMatchObject({
          grant_type: "refresh_token",
          refresh_token: "repo_grant_e2e",
          client_id: "github-mcp",
        });
      }
      const after = await db.query(
        'SELECT 1 FROM downstream_tokens WHERE "connectionId" = $1',
        [childId],
      );
      expect(after.rowCount).toBe(1);
    } finally {
      await Promise.allSettled([
        db.end(),
        ctx.dispose(),
        tokenEndpoint?.stop(),
        repoStub?.stop(),
      ]);
    }
  });
});
