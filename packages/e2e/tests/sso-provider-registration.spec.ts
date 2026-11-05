import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

test("a signed-in user cannot register an SSO provider", async ({
  playwright,
}) => {
  const ctx = await newApiContext(playwright);
  await signUpViaApi(ctx);

  const issuer = "https://idp.example.test";
  const providerId = `e2e-idp-${Date.now()}`;
  const register = await ctx.post("/api/auth/sso/register", {
    data: {
      providerId,
      issuer,
      domain: "example.test",
      oidcConfig: {
        clientId: "client",
        clientSecret: "secret",
        authorizationEndpoint: `${issuer}/authorize`,
        tokenEndpoint: `${issuer}/token`,
        jwksEndpoint: `${issuer}/jwks`,
        scopes: ["openid", "email"],
        mapping: { id: "sub", email: "email", name: "name" },
      },
    },
  });
  expect(register.status()).toBe(403);

  const signIn = await ctx.post("/api/auth/sign-in/sso", {
    data: { email: "someone@example.test", callbackURL: "/" },
  });
  expect(signIn.ok()).toBe(false);

  await ctx.dispose();
});
