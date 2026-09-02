/**
 * Guards on `GET /api/:org/connections/:id/jira/attachments/:attId`.
 *
 * The route spends a connection's vaulted Atlassian OAuth token on the
 * caller's behalf, so the interesting contract is everything it REFUSES. All
 * of that is assertable without an Atlassian credential: each case below stops
 * before any upstream call, which is exactly the property worth pinning —
 * a regression here means a token gets spent, or sent somewhere it shouldn't.
 *
 * The happy path (real token → real bytes) needs a live Atlassian connection
 * and is deliberately not faked here; a stubbed `api.atlassian.com` would
 * assert our own mock, not the contract.
 *
 * Black-box: real signup, real middleware, real DB. Assertions on HTTP status
 * and body only.
 */

import { signUpViaApi } from "../fixtures/auth-api";
import { createHttpConnection } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

/** Shape of the org's real Atlassian MCP connection, minus the credential. */
const ATLASSIAN_MCP_URL = "https://mcp.atlassian.com/v1/mcp/authv2";

const attachmentUrl = (orgSlug: string, connectionId: string, attId: string) =>
  `/api/${orgSlug}/connections/${connectionId}/jira/attachments/${attId}`;

test.describe("jira attachment proxy guards", () => {
  test("refuses to spend a non-Atlassian connection's credential", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const owner = await signUpViaApi(ctx);

    // A connection that is emphatically not Atlassian. Without the host guard
    // its token would be shipped to api.atlassian.com.
    const notAtlassian = await createHttpConnection(ctx, owner.orgSlug, {
      title: "Notion (not Atlassian)",
      url: "https://mcp.notion.com/mcp",
    });

    const res = await ctx.get(
      attachmentUrl(owner.orgSlug, notAtlassian.id, "41356"),
    );
    // 400, not 403: the member IS authorized (JIRA_ATTACHMENT_READ is a
    // basic-usage key) — the connection is simply the wrong kind. A 403 here
    // would mean the permission wiring is broken instead.
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("Not an Atlassian connection");

    await ctx.dispose();
  });

  test("a look-alike host does not pass for Atlassian", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const owner = await signUpViaApi(ctx);

    const lookalike = await createHttpConnection(ctx, owner.orgSlug, {
      title: "Atlassian look-alike",
      url: "https://atlassian.com.example.test/mcp",
    });

    const res = await ctx.get(
      attachmentUrl(owner.orgSlug, lookalike.id, "41356"),
    );
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("Not an Atlassian connection");

    await ctx.dispose();
  });

  test("an Atlassian connection with no stored token fails closed", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const owner = await signUpViaApi(ctx);

    const atlassian = await createHttpConnection(ctx, owner.orgSlug, {
      title: "Osklen - Atlassian (Jira)",
      url: ATLASSIAN_MCP_URL,
    });

    const res = await ctx.get(
      attachmentUrl(owner.orgSlug, atlassian.id, "41356"),
    );
    // 409 = "reconnect it", a state the caller can act on — not a 500, and
    // not an unauthenticated call to Atlassian.
    expect(res.status()).toBe(409);
    expect(await res.text()).toContain("No usable Atlassian credential");

    await ctx.dispose();
  });

  test("a non-numeric attachment id is rejected before anything else", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const owner = await signUpViaApi(ctx);

    const atlassian = await createHttpConnection(ctx, owner.orgSlug, {
      title: "Atlassian",
      url: ATLASSIAN_MCP_URL,
    });

    for (const hostile of [
      encodeURIComponent("../../../etc/passwd"),
      encodeURIComponent("41356?x=1"),
      "abc",
      "-1",
    ]) {
      const res = await ctx.get(
        attachmentUrl(owner.orgSlug, atlassian.id, hostile),
      );
      // 400 from the id guard, or 404 when the encoded segment doesn't match
      // the route at all — either way it is never served. No body assertion:
      // the 404 handler echoes the request path, so any substring taken from
      // the input matches by construction and proves nothing.
      expect(
        [400, 404],
        `attachment id ${hostile} should not be served`,
      ).toContain(res.status());
    }

    await ctx.dispose();
  });

  test("an unknown connection is a 404, not a probe of another org", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const owner = await signUpViaApi(ctx);

    const res = await ctx.get(
      attachmentUrl(owner.orgSlug, "conn_does-not-exist", "41356"),
    );
    expect(res.status()).toBe(404);

    await ctx.dispose();
  });

  test("a non-member cannot fetch through another org's connection", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const atlassian = await createHttpConnection(ownerCtx, owner.orgSlug, {
      title: "Atlassian",
      url: ATLASSIAN_MCP_URL,
    });

    // Sanity: the owner reaches the route at all (409 = past every gate,
    // stopped only by the missing token). Without this the 403 below could
    // pass for the wrong reason.
    const ownerRes = await ownerCtx.get(
      attachmentUrl(owner.orgSlug, atlassian.id, "41356"),
    );
    expect(ownerRes.status()).toBe(409);

    const outsiderCtx = await newApiContext(playwright);
    await signUpViaApi(outsiderCtx);
    const outsiderRes = await outsiderCtx.get(
      attachmentUrl(owner.orgSlug, atlassian.id, "41356"),
    );
    expect(outsiderRes.status()).toBe(403);

    const anonCtx = await newApiContext(playwright);
    const anonRes = await anonCtx.get(
      attachmentUrl(owner.orgSlug, atlassian.id, "41356"),
    );
    // The middleware owns the exact code for an anonymous caller; the contract
    // this pins is that the route is not served.
    expect([401, 403]).toContain(anonRes.status());

    await anonCtx.dispose();
    await outsiderCtx.dispose();
    await ownerCtx.dispose();
  });
});
