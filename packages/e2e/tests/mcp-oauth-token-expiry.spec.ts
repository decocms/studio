/**
 * E2E: an expired MCP OAuth access token does not authenticate.
 *
 * The token row is found by value; its `accessTokenExpiresAt` has to be
 * checked by whoever reads it. Covered here: the org-scoped MCP endpoint and
 * the desktop routes, one of which mints a new Better Auth session from the
 * bearer.
 */
import type { Client } from "pg";
import { signUpViaApi } from "../fixtures/auth-api";
import { connectDevDb } from "../fixtures/db";
import { mintMcpAccessToken } from "../fixtures/mcp-oauth";
import { expect, newApiContext, test } from "../fixtures/test";

const automationList = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/call",
  params: { name: "AUTOMATION_LIST", arguments: {} },
};

test.describe("MCP OAuth access token expiry", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("an expired access token is rejected everywhere it is accepted", async ({
    playwright,
  }) => {
    const userCtx = await newApiContext(playwright);
    const user = await signUpViaApi(userCtx);
    const { accessToken } = await mintMcpAccessToken(userCtx);

    const apiCtx = await newApiContext(playwright);
    const auth = { Authorization: `Bearer ${accessToken}` };
    const callMcp = () =>
      apiCtx.post(`/api/${user.orgSlug}/mcp/self`, {
        headers: { ...auth, Accept: "application/json, text/event-stream" },
        data: automationList,
      });

    const fresh = await callMcp();
    expect(fresh.status(), await fresh.text()).toBe(200);
    expect(
      (await apiCtx.get("/api/auth/desktop/me", { headers: auth })).status(),
    ).toBe(200);

    const updated = await db.query(
      `UPDATE "oauthAccessToken"
          SET "accessTokenExpiresAt" = now() - interval '1 minute'
        WHERE "accessToken" = $1`,
      [accessToken],
    );
    expect(updated.rowCount).toBe(1);

    expect((await callMcp()).status(), "org-scoped MCP endpoint").toBe(401);
    expect(
      (await apiCtx.get("/api/auth/desktop/me", { headers: auth })).status(),
      "GET /api/auth/desktop/me",
    ).toBe(401);
    expect(
      (
        await apiCtx.post("/api/auth/desktop/session-from-oauth", {
          headers: auth,
        })
      ).status(),
      "POST /api/auth/desktop/session-from-oauth",
    ).toBe(401);

    await userCtx.dispose();
    await apiCtx.dispose();
  });
});
