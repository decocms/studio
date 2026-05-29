/**
 * Shared inline-connect pipeline: turn a registry item into a created (and, if
 * needed, OAuth-authenticated) connection. No UI side effects — callers handle
 * toasts/tracking/navigation. Used by the connect gate (`useConnectApp`) and
 * the add-connection dialog.
 */
import type { useConnectionActions } from "@decocms/mesh-sdk";
import type { QueryClient } from "@tanstack/react-query";
import type { RegistryItem } from "@/web/components/store/types";
import {
  authenticateMcp,
  isConnectionAuthenticated,
  type OAuthTokenInfo,
} from "@/web/lib/mcp-oauth";
import { KEYS } from "@/web/lib/query-keys";
import { extractConnectionData } from "@/web/utils/extract-connection-data";

export interface ConnectAppDeps {
  org: { id: string; slug: string };
  userId: string;
  connectionActions: ReturnType<typeof useConnectionActions>;
  queryClient: QueryClient;
  /** Reports pipeline progress so callers can show per-phase UI. */
  onPhase?: (phase: "connecting" | "authenticating") => void;
}

export interface ConnectAppResult {
  /** The created connection id, or null if creation never happened. */
  id: string | null;
  oauth: "not-needed" | "succeeded" | "failed";
  /**
   * `"no-connection-method"` when the item has no URL/STDIO command (nothing
   * created), an OAuth error string when `oauth === "failed"`, else null.
   */
  error: string | null;
}

/**
 * Persist a freshly obtained downstream OAuth token for an existing connection.
 *
 * Posts the structured token to the connection's oauth-token endpoint; on any
 * failure (or when the provider returned no `tokenInfo`) falls back to storing
 * the raw token on the connection so it still works. On success an empty update
 * triggers the mutation's cache invalidation / tool refresh. Never throws —
 * every failure degrades to the fallback path.
 */
export async function persistDownstreamToken(deps: {
  orgSlug: string;
  connectionId: string;
  token: string;
  tokenInfo: OAuthTokenInfo | null;
  connectionActions: ReturnType<typeof useConnectionActions>;
}): Promise<void> {
  const { orgSlug, connectionId, token, tokenInfo, connectionActions } = deps;

  const storeRawToken = () =>
    connectionActions.update.mutateAsync({
      id: connectionId,
      data: { connection_token: token },
    });

  if (!tokenInfo) {
    await storeRawToken();
    return;
  }

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
    if (!response.ok) {
      await storeRawToken();
      return;
    }
    // Server persisted the token; the empty update just kicks the mutation's
    // cache invalidation / tool refresh. Best-effort — the token is already
    // saved, so a refresh failure must not surface as an auth failure.
    try {
      await connectionActions.update.mutateAsync({
        id: connectionId,
        data: {},
      });
    } catch {
      // non-fatal
    }
  } catch {
    await storeRawToken();
  }
}

export async function connectApp(
  item: RegistryItem,
  deps: ConnectAppDeps,
): Promise<ConnectAppResult> {
  const { org, userId, connectionActions, queryClient, onPhase } = deps;

  const connectionData = extractConnectionData(item, org.id, userId, {
    remoteIndex: 0,
  });

  const isStdio = connectionData.connection_type === "STDIO";
  const hasUrl = Boolean(connectionData.connection_url);
  const hasStdioConfig =
    isStdio &&
    connectionData.connection_headers &&
    typeof connectionData.connection_headers === "object" &&
    "command" in connectionData.connection_headers;
  if (!hasUrl && !hasStdioConfig) {
    return { id: null, oauth: "not-needed", error: "no-connection-method" };
  }

  onPhase?.("connecting");
  const { id } = await connectionActions.create.mutateAsync(connectionData);

  const mcpProxyUrl = new URL(
    `/api/${org.slug}/mcp/${id}`,
    window.location.origin,
  );
  const authStatus = await isConnectionAuthenticated({
    url: mcpProxyUrl.href,
    token: null,
    orgId: org.id,
  });

  const needsOAuth = authStatus.supportsOAuth && !authStatus.isAuthenticated;
  if (!needsOAuth) {
    return { id, oauth: "not-needed", error: null };
  }

  onPhase?.("authenticating");
  const { token, tokenInfo, error } = await authenticateMcp({
    connectionId: id,
    orgSlug: org.slug,
    scope: "offline_access",
  });
  if (error || !token) {
    return { id, oauth: "failed", error: error ?? "no token received" };
  }

  await persistDownstreamToken({
    orgSlug: org.slug,
    connectionId: id,
    token,
    tokenInfo,
    connectionActions,
  });

  await queryClient.invalidateQueries({
    queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
  });

  return { id, oauth: "succeeded", error: null };
}
