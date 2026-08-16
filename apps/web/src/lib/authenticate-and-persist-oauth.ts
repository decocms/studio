import { authenticateMcp, isConnectionAuthenticated } from "@/lib/mcp-oauth";

export interface AuthenticateAndPersistParams {
  connectionId: string;
  orgId: string;
  orgSlug: string;
  /** Called with the raw token when the oauth-token POST fails, to persist as connection_token. */
  persistFallback: (token: string) => Promise<void>;
}

/** Authenticate a connection via OAuth if it needs it, and persist the token.
 * Returns { ran:false } when no OAuth was required (already authed / no OAuth support).
 * Mirrors the tail shared by handleConnectAndAdd / useAutoInstallGitHub. */
export async function authenticateAndPersistOAuth({
  connectionId,
  orgId,
  orgSlug,
  persistFallback,
}: AuthenticateAndPersistParams): Promise<{
  ran: boolean;
  ok: boolean;
  error: string | null;
}> {
  const mcpProxyUrl = new URL(
    `/api/${orgSlug}/mcp/${connectionId}`,
    window.location.origin,
  );
  const authStatus = await isConnectionAuthenticated({
    url: mcpProxyUrl.href,
    token: null,
    orgId,
  });

  if (!authStatus.supportsOAuth || authStatus.isAuthenticated) {
    return { ran: false, ok: true, error: null };
  }

  // Do not hardcode "offline_access": Figma and other MCP OAuth servers
  // advertise their own scopes (e.g. mcp:connect). Passing an OIDC-ism
  // makes strict DCR reject the registration.
  const { token, tokenInfo, error } = await authenticateMcp({
    connectionId,
    orgSlug,
  });
  if (error || !token) {
    return { ran: true, ok: false, error: error ?? "no token received" };
  }

  if (tokenInfo) {
    try {
      const response = await fetch(
        `/api/${orgSlug}/connections/${connectionId}/oauth-token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            accessToken: tokenInfo.accessToken,
            refreshToken: tokenInfo.refreshToken,
            expiresIn: tokenInfo.expiresIn,
            scope: tokenInfo.scope,
            clientId: tokenInfo.clientId,
            clientSecret: tokenInfo.clientSecret,
            tokenEndpoint: tokenInfo.tokenEndpoint,
          }),
        },
      );
      if (!response.ok) await persistFallback(token);
    } catch {
      await persistFallback(token);
    }
  } else {
    await persistFallback(token);
  }
  return { ran: true, ok: true, error: null };
}
