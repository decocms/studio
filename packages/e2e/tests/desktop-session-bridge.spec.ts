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

test.describe("desktop identity: GET /api/auth/desktop/me", () => {
  test("returns the same stable identity for a session cookie and API-key bearer", async ({
    playwright,
  }) => {
    const sessionCtx = await newApiContext(playwright);
    const user = await signUpViaApi(sessionCtx);

    const cookieResponse = await sessionCtx.get("/api/auth/desktop/me");
    expect(cookieResponse.status()).toBe(200);
    expect(await cookieResponse.json()).toEqual({ userId: user.userId });

    const keyResponse = await sessionCtx.post(
      `/api/${user.orgSlug}/tools/API_KEY_CREATE`,
      {
        data: {
          name: `desktop-me-${Date.now()}`,
          permissions: { "*": ["*"] },
        },
      },
    );
    expect(keyResponse.ok()).toBe(true);
    const apiKey = ((await keyResponse.json()) as { key?: string }).key;
    expect(apiKey).toBeTruthy();

    const bearerCtx = await newApiContext(playwright);
    const bearerResponse = await bearerCtx.get("/api/auth/desktop/me", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(bearerResponse.status()).toBe(200);
    expect(await bearerResponse.json()).toEqual({ userId: user.userId });

    await Promise.all([sessionCtx.dispose(), bearerCtx.dispose()]);
  });

  test("rejects missing and invalid credentials", async ({ playwright }) => {
    const ctx = await newApiContext(playwright);

    const missing = await ctx.get("/api/auth/desktop/me");
    expect(missing.status()).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });

    const invalid = await ctx.get("/api/auth/desktop/me", {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(invalid.status()).toBe(401);
    expect(await invalid.json()).toEqual({ error: "unauthorized" });

    await ctx.dispose();
  });
});

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
