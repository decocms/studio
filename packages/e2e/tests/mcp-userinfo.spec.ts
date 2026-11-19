/**
 * `GET|POST /api/auth/mcp/userinfo` (OIDC Core 5.3) returns the identity behind
 * a real MCP OAuth access token, limited to the granted scopes, and rejects
 * anything else with 401. Real signup, real token, assertions on HTTP only.
 */

import { signUpViaApi } from "../fixtures/auth-api";
import { mintMcpAccessToken } from "../fixtures/mcp-oauth";
import { expect, newApiContext, test } from "../fixtures/test";

const USERINFO = "/api/auth/mcp/userinfo";

test.describe("MCP OAuth userinfo", () => {
  test("returns sub, email and profile claims for the token's user", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const { accessToken } = await mintMcpAccessToken(ownerCtx);

    // A fresh context: no session cookie, only the bearer token.
    const bearerCtx = await newApiContext(playwright);
    const headers = { authorization: `Bearer ${accessToken}` };
    for (const res of [
      await bearerCtx.get(USERINFO, { headers }),
      await bearerCtx.post(USERINFO, { headers }),
    ]) {
      expect(res.status(), await res.text()).toBe(200);
      expect(res.headers()["cache-control"]).toBe("no-store");
      const claims = (await res.json()) as Record<string, unknown>;
      expect(typeof claims.sub).toBe("string");
      expect(claims.email).toBe(owner.email);
      expect(typeof claims.email_verified).toBe("boolean");
      expect(claims.name).toBe(owner.name);
    }

    await bearerCtx.dispose();
    await ownerCtx.dispose();
  });

  test("leaves out email claims when the email scope was not granted", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    await signUpViaApi(ownerCtx);
    const { accessToken } = await mintMcpAccessToken(
      ownerCtx,
      "openid profile",
    );

    const bearerCtx = await newApiContext(playwright);
    const res = await bearerCtx.get(USERINFO, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.status(), await res.text()).toBe(200);
    const claims = (await res.json()) as Record<string, unknown>;
    expect(typeof claims.sub).toBe("string");
    expect(claims).not.toHaveProperty("email");
    expect(claims).not.toHaveProperty("email_verified");

    await bearerCtx.dispose();
    await ownerCtx.dispose();
  });

  test("rejects a missing or unknown token with 401", async ({
    playwright,
  }) => {
    const anonCtx = await newApiContext(playwright);

    const missing = await anonCtx.get(USERINFO);
    expect(missing.status()).toBe(401);
    expect(missing.headers()["www-authenticate"]).toBe("Bearer");

    const unknown = await anonCtx.get(USERINFO, {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(unknown.status()).toBe(401);
    expect(unknown.headers()["www-authenticate"]).toBe(
      'Bearer error="invalid_token"',
    );

    await anonCtx.dispose();
  });
});
