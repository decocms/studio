import { Hono } from "hono";
import { getProxyTokenJwks } from "../../auth/jwt-signature";

/**
 * Publishes the public key(s) used to verify proxy tokens (x-mesh-token /
 * x-studio-token) signed by ../../auth/jwt-signature.ts. See issue #8440.
 */
export const createProxyTokenJwksRoutes = () => {
  const app = new Hono();

  app.get("/.well-known/jwks.json", async (c) => {
    const jwks = await getProxyTokenJwks();
    c.header("Cache-Control", "public, max-age=300");
    return c.json(jwks);
  });

  return app;
};
