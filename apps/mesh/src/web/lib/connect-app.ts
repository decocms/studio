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

  if (!(authStatus.supportsOAuth && !authStatus.isAuthenticated)) {
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

  if (tokenInfo) {
    try {
      const response = await fetch(
        `/api/${org.slug}/connections/${id}/oauth-token`,
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
        await connectionActions.update.mutateAsync({
          id,
          data: { connection_token: token },
        });
      } else {
        await connectionActions.update.mutateAsync({ id, data: {} });
      }
    } catch {
      await connectionActions.update.mutateAsync({
        id,
        data: { connection_token: token },
      });
    }
  } else {
    await connectionActions.update.mutateAsync({
      id,
      data: { connection_token: token },
    });
  }

  await queryClient.invalidateQueries({
    queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
  });

  return { id, oauth: "succeeded", error: null };
}
