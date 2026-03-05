/**
 * Request Header Builder
 *
 * Shared utility for building request headers for outbound connections.
 * Handles configuration token issuance and OAuth token refresh.
 */

import { extractConnectionPermissions } from "@/auth/configuration-scopes";
import { issueMeshToken } from "@/auth/jwt";
import type { MeshContext } from "@/core/mesh-context";
import { refreshAccessToken } from "@/oauth/token-refresh";
import { DownstreamTokenStorage } from "@/storage/downstream-token";
import type { ConnectionEntity } from "@/tools/connection/schema";

/**
 * Build request headers for HTTP-based connections
 * Handles configuration token issuance and OAuth token refresh
 *
 * @param connection - Connection entity from database
 * @param ctx - Mesh context
 * @param superUser - Whether to use superuser mode for background processes
 * @returns Headers object ready to be used in HTTP requests
 */
export async function buildRequestHeaders(
  connection: ConnectionEntity,
  ctx: MeshContext,
  superUser: boolean,
): Promise<Record<string, string>> {
  const connectionId = connection.id;

  // Issue configuration JWT lazily (only when needed)
  // This avoids issuing tokens when creating proxies that may never be used.
  // Extract connection permissions from configuration state and scopes
  // Format: "KEY::SCOPE" where KEY is in state and state[KEY].value is a connection ID
  // Result: { [connectionId]: [scopes...] }
  const permissions = extractConnectionPermissions(
    connection.configuration_state as Record<string, unknown> | null,
    connection.configuration_scopes,
  );

  const userId =
    ctx.auth.user?.id ??
    ctx.auth.apiKey?.userId ??
    (superUser ? connection.created_by : undefined);

  // Issue short-lived JWT with configuration permissions
  // JWT can be decoded directly by downstream to access payload
  // TODO: The superUser fallback to connection.created_by is a workaround for background
  // processes (e.g., event-triggered handlers) that need a userId but aren't acting as a
  // real user. This causes monitoring to incorrectly attribute actions to the connection
  // creator. Better solution: create a dedicated "Decopilot" service user per organization
  // for automated actions, so they're properly distinguished from real user activity.
  const [configurationToken, error] = userId
    ? await issueMeshToken({
        sub: userId,
        user: { id: userId },
        metadata: {
          state: connection.configuration_state ?? undefined,
          meshUrl: ctx.baseUrl,
          connectionId,
          organizationId: ctx.organization?.id,
          organizationName: ctx.organization?.name,
          organizationSlug: ctx.organization?.slug,
        },
        permissions,
      })
        .then((token) => [token, null] as const)
        .catch((error) => [null, error] as const)
    : [null, new Error("User ID required to issue configuration token")];

  if (error) {
    console.error("Failed to issue configuration token:", configurationToken);
  }

  const callerConnectionId = ctx.auth.user?.connectionId;
  const headers: Record<string, string> = {
    ...(callerConnectionId ? { "x-caller-id": callerConnectionId } : {}),
    ...(ctx.metadata.wellKnownForwardableHeaders ?? {}),
    "x-request-id": ctx.metadata.requestId,
  };

  // Try to get cached token from downstream_tokens first
  // This supports OAuth token refresh for connections that use OAuth
  let accessToken: string | null = null;

  const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
  const cachedToken = await tokenStorage.get(connectionId);

  if (cachedToken) {
    const canRefresh =
      !!cachedToken.refreshToken && !!cachedToken.tokenEndpoint;
    // If we can refresh, treat "expiring soon" as expired to proactively refresh.
    // If we cannot refresh, only treat as expired at actual expiry (no buffer),
    // otherwise short-lived tokens would be deleted immediately.
    const isExpired = tokenStorage.isExpired(
      cachedToken,
      canRefresh ? 5 * 60 * 1000 : 0,
    );

    if (isExpired) {
      // Try to refresh if we have refresh capability
      if (canRefresh) {
        console.log(
          `[Proxy] Token expired for ${connectionId}, attempting refresh`,
        );
        const refreshResult = await refreshAccessToken(cachedToken);

        if (refreshResult.success && refreshResult.accessToken) {
          // Save refreshed token
          await tokenStorage.upsert({
            connectionId,
            accessToken: refreshResult.accessToken,
            refreshToken:
              refreshResult.refreshToken ?? cachedToken.refreshToken,
            scope: refreshResult.scope ?? cachedToken.scope,
            expiresAt: refreshResult.expiresIn
              ? new Date(Date.now() + refreshResult.expiresIn * 1000)
              : null,
            clientId: cachedToken.clientId,
            clientSecret: cachedToken.clientSecret,
            tokenEndpoint: cachedToken.tokenEndpoint,
          });

          accessToken = refreshResult.accessToken;
          console.log(`[Proxy] Token refreshed for ${connectionId}`);
        } else {
          // Refresh failed - token is invalid
          // Delete the cached token so user gets prompted to re-auth
          await tokenStorage.delete(connectionId);
          console.error(
            `[Proxy] Token refresh failed for ${connectionId}: ${refreshResult.error}`,
          );
        }
      } else {
        // Token expired but no refresh capability - delete it
        await tokenStorage.delete(connectionId);
        console.log(
          `[Proxy] Token expired without refresh capability for ${connectionId}`,
        );
      }
    } else {
      // Token is still valid
      accessToken = cachedToken.accessToken;
    }
  }

  // Fall back to connection token if no cached token
  if (!accessToken && connection.connection_token) {
    accessToken = connection.connection_token;
  }

  // Add authorization header if we have a token
  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  // Add configuration token if issued
  if (configurationToken) {
    headers["x-mesh-token"] = configurationToken;
  }

  return headers;
}
