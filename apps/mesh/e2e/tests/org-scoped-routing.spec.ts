/**
 * Org-scoped routing boundary tests.
 *
 * Migrates the routing-layer assertions from
 * apps/mesh/src/api/integration-org-scoped.test.ts to real Playwright
 * specs against real Better Auth + resolveOrgFromPath middleware:
 *
 *   - new path serves the route (200)
 *   - legacy unscoped path still serves (200) [log assertion dropped:
 *     can't capture dev-server stdout from Playwright]
 *   - new path 404 for unknown slug
 *   - new path 403 for non-member principal
 *
 * The remaining tests in that file (well-known prefix discovery, OAuth
 * DCR, auth-server-metadata, oauth-proxy slug-spoofing) are deferred to
 * follow-up PRs — they need OAuth client registration plumbing that this
 * migration scope doesn't cover.
 *
 * Endpoint choice: we hit `/mcp/self` (the built-in management MCP)
 * because it's a cheap tools/list call that goes through the same
 * resolveOrgFromPath middleware as the connection-scoped routes the
 * unit test used — no real downstream connection required.
 */

import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

const MCP_HEADERS = { Accept: "application/json, text/event-stream" };

const toolsListBody = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/list",
};

test.describe("org-scoped routing middleware", () => {
  test("new path returns 200 for a member of the resolved org", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const user = await signUpViaApi(ctx);

    const res = await ctx.post(`/api/${user.orgSlug}/mcp/self`, {
      data: toolsListBody,
      headers: MCP_HEADERS,
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    expect(Array.isArray(body.result?.tools)).toBe(true);

    await ctx.dispose();
  });

  test("legacy unscoped path still serves the same request", async ({
    playwright,
  }) => {
    // Legacy mount is at `/mcp/self` (no org prefix). It survives behind a
    // deprecation log middleware; we only assert it still responds —
    // capturing the actual log line would require dev-server stdout, which
    // Playwright doesn't surface.
    const ctx = await newApiContext(playwright);
    await signUpViaApi(ctx);

    const res = await ctx.post(`/mcp/self`, {
      data: toolsListBody,
      headers: MCP_HEADERS,
    });
    expect(res.status()).toBe(200);

    await ctx.dispose();
  });

  test("new path returns 404 for an unknown slug", async ({ playwright }) => {
    const ctx = await newApiContext(playwright);
    await signUpViaApi(ctx);

    // The signed-in user has cookies, so auth would pass — the slug lookup
    // in resolveOrgFromPath is what 404s.
    const res = await ctx.post(
      `/api/definitely-not-a-real-org-${Date.now()}/mcp/self`,
      { data: toolsListBody, headers: MCP_HEADERS },
    );
    expect(res.status()).toBe(404);

    await ctx.dispose();
  });

  test("new path returns 403 for a principal who isn't a member", async ({
    playwright,
  }) => {
    // User A owns org A.
    const userACtx = await newApiContext(playwright);
    const userA = await signUpViaApi(userACtx);

    // User B has their own org but no membership in org A.
    const userBCtx = await newApiContext(playwright);
    await signUpViaApi(userBCtx);

    // B tries to hit A's org — middleware should 403.
    const res = await userBCtx.post(`/api/${userA.orgSlug}/mcp/self`, {
      data: toolsListBody,
      headers: MCP_HEADERS,
    });
    expect(res.status()).toBe(403);

    await userACtx.dispose();
    await userBCtx.dispose();
  });
});
