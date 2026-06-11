/**
 * Resolve a link-daemon bearer (MCP OAuth session OR a Better Auth API key) to
 * a userSub — the same dual-auth `/api/links/me` relies on. Extracted so the WS
 * uplink upgrade in index.ts (which runs OUTSIDE Hono's `ctx.auth` middleware)
 * authenticates identically. `X-MCP-Session-Auth: true` is set on a FRESH
 * Headers so the apiKey plugin skips the non-key bearer (avoids the
 * INVALID_API_KEY throw); the marker is never client-trusted.
 */
export interface LinkBearerAuthApi {
  getMcpSession(args: {
    headers: Headers;
  }): Promise<{ userId?: string } | null>;
  verifyApiKey(args: {
    body: { key: string };
  }): Promise<{ valid?: boolean; key?: { userId?: string } } | null>;
}

export async function resolveLinkBearer(
  token: string,
  api: LinkBearerAuthApi,
): Promise<string | null> {
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "X-MCP-Session-Auth": "true",
  });
  const mcp = await api.getMcpSession({ headers }).catch(() => null);
  if (mcp?.userId) return mcp.userId;
  // Dev fallback: a Better Auth API key as the bearer (no local OIDC).
  const verified = await api
    .verifyApiKey({ body: { key: token } })
    .catch(() => null);
  if (verified?.valid && verified.key?.userId) return verified.key.userId;
  return null;
}
