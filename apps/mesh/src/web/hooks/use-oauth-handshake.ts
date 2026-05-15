/**
 * Shared OAuth handshake for "install + authenticate a connection" flows.
 *
 * Probes the connection's auth status, runs the OAuth popup if needed, and
 * persists the resulting token via POST /oauth-token. Used by both
 * useAutoInstallGitHub and useAutoInstallSystemHealth — the differences
 * between the two flows (how the connection itself is created, whether
 * to clean up on OAuth failure, whether to fall back to actions.update
 * when token persistence fails) are passed in as callbacks.
 */

import { authenticateMcp, isConnectionAuthenticated } from "@decocms/mesh-sdk";

export interface OAuthHandshakeOpts {
  connectionId: string;
  org: { id: string; slug: string };
  scope?: string;
  /** Invoked when OAuth itself fails — e.g. github wants to delete the just-created connection. */
  onOAuthFailure?: (connectionId: string) => Promise<void> | void;
  /** Invoked when POST /oauth-token fails — github falls back to actions.update. */
  onPersistFallback?: (connectionId: string, token: string) => Promise<void>;
}

export type OAuthHandshakeResult =
  | { ok: true; token: string | null }
  | { ok: false; error: string };

export async function runOAuthHandshake(
  opts: OAuthHandshakeOpts,
): Promise<OAuthHandshakeResult> {
  const { connectionId, org } = opts;
  const mcpProxyUrl = new URL(
    `/api/${org.slug}/mcp/${connectionId}`,
    window.location.origin,
  );
  const authStatus = await isConnectionAuthenticated({
    url: mcpProxyUrl.href,
    token: null,
    orgId: org.id,
  });
  if (!authStatus.supportsOAuth || authStatus.isAuthenticated) {
    return { ok: true, token: null };
  }

  const {
    token,
    tokenInfo,
    error: oauthError,
  } = await authenticateMcp({
    connectionId,
    orgSlug: org.slug,
    scope: opts.scope ?? "offline_access",
  });

  if (oauthError || !token) {
    if (opts.onOAuthFailure) {
      try {
        await opts.onOAuthFailure(connectionId);
      } catch {
        // Best-effort cleanup.
      }
    }
    return { ok: false, error: oauthError ?? "No token received" };
  }

  if (tokenInfo) {
    try {
      const response = await fetch(
        `/api/${org.slug}/connections/${connectionId}/oauth-token`,
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
      if (!response.ok) {
        if (opts.onPersistFallback) {
          await opts.onPersistFallback(connectionId, token);
        } else {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          return { ok: false, error: body.error ?? "Failed to persist token" };
        }
      }
    } catch (err) {
      if (opts.onPersistFallback) {
        await opts.onPersistFallback(connectionId, token);
      } else {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  return { ok: true, token };
}
