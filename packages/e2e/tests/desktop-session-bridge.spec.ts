/**
 * `POST /api/auth/desktop/session-from-oauth` — the Studio-side bridge that
 * closes the desktop system-browser (Google/GitHub/SAML) login gap: an MCP
 * OAuth access token satisfies org-scoped `/api/:org/*` routes but is
 * rejected by Better Auth's native session endpoints (`get-session`,
 * `organization.list`), which only recognize a session cookie. This bridge
 * mints a real Better Auth session from a valid MCP OAuth bearer and returns
 * the signed cookie VALUE, so a native caller (the desktop app) can forward
 * it itself as `Cookie: better-auth.session_token=<value>`.
 *
 * See the native authentication contract for the full empirical
 * trail and `apps/native/crates/upstream/src/login.rs`'s
 * `mint_session_from_access_token` for the Rust-side caller.
 */
import { expect, newApiContext, test } from "../fixtures/test";
import { signUpViaApi } from "../fixtures/auth-api";
import { mintMcpAccessToken } from "../fixtures/mcp-oauth";

test.describe("desktop session bridge: POST /api/auth/desktop/session-from-oauth", () => {
  test("exchanges a valid MCP OAuth bearer for a Better Auth session cookie the native endpoints accept", async ({
    playwright,
  }) => {
    const signedUpCtx = await newApiContext(playwright);
    const user = await signUpViaApi(signedUpCtx);

    const { accessToken } = await mintMcpAccessToken(signedUpCtx);

    const bridgeRes = await signedUpCtx.post(
      "/api/auth/desktop/session-from-oauth",
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    expect(bridgeRes.status()).toBe(200);
    const { sessionToken } = (await bridgeRes.json()) as {
      sessionToken: string;
    };
    expect(typeof sessionToken).toBe("string");
    expect(sessionToken.length).toBeGreaterThan(0);

    // A brand-new, cookie-free context — proves the bridged value ALONE
    // (nothing carried over from `signUpViaApi`'s own session) satisfies
    // Better Auth's native endpoints, exactly what the real production
    // shell's sign-in gate (`useSession`) and org switcher
    // (`organization.list`) call.
    const bareCtx = await newApiContext(playwright);
    const cookieHeader = `better-auth.session_token=${sessionToken}`;

    const sessionRes = await bareCtx.get("/api/auth/get-session", {
      headers: { cookie: cookieHeader },
    });
    expect(sessionRes.status()).toBe(200);
    const sessionBody = (await sessionRes.json()) as {
      user?: { id?: string };
    };
    expect(sessionBody.user?.id).toBe(user.userId);

    const orgListRes = await bareCtx.get("/api/auth/organization/list", {
      headers: { cookie: cookieHeader },
    });
    expect(orgListRes.status()).toBe(200);
    const orgs = (await orgListRes.json()) as Array<{ slug: string }>;
    expect(orgs.some((o) => o.slug === user.orgSlug)).toBe(true);

    await signedUpCtx.dispose();
    await bareCtx.dispose();
  });

  test("rejects a missing or invalid bearer", async ({ playwright }) => {
    const ctx = await newApiContext(playwright);

    const noAuthRes = await ctx.post("/api/auth/desktop/session-from-oauth");
    expect(noAuthRes.status()).toBe(401);

    const badAuthRes = await ctx.post("/api/auth/desktop/session-from-oauth", {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(badAuthRes.status()).toBe(401);

    await ctx.dispose();
  });
});
