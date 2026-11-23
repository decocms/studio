/**
 * UserInfo endpoint of the MCP OAuth server (OIDC Core 5.3).
 *
 *   GET|POST /api/auth/mcp/userinfo   Authorization: Bearer <access token>
 *
 * Mounted ahead of the Better Auth catch-all: the `mcp()` plugin advertises
 * this path in its metadata but does not serve it. The token is looked up
 * directly, so the API key plugin never sees it.
 */

import { Hono, type Context } from "hono";
import { auth } from "../../auth";
import {
  bearerToken,
  grantedScopes,
  isTokenUsable,
  userinfoClaims,
  type UserinfoToken,
  type UserinfoUser,
} from "../../auth/mcp-userinfo";

interface AccessTokenRow extends UserinfoToken {
  userId: string;
}

function invalidToken(c: Context) {
  c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
  c.header("Cache-Control", "no-store");
  return c.json({ error: "invalid_token" }, 401);
}

async function userinfo(c: Context) {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) {
    c.header("WWW-Authenticate", "Bearer");
    return c.json({ error: "invalid_request" }, 401);
  }
  const ctx = await auth.$context;
  const row = await ctx.adapter.findOne<AccessTokenRow>({
    model: "oauthAccessToken",
    where: [{ field: "accessToken", value: token }],
  });
  if (!row || !isTokenUsable(row, new Date())) return invalidToken(c);
  const user = (await ctx.internalAdapter.findUserById(
    row.userId,
  )) as UserinfoUser | null;
  if (!user) return invalidToken(c);
  c.header("Cache-Control", "no-store");
  return c.json(userinfoClaims(user, grantedScopes(row.scopes)));
}

const app = new Hono();
app.get("/", userinfo);
app.post("/", userinfo);

export default app;
