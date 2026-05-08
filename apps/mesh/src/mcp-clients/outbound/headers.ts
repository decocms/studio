/**
 * Request Header Builder
 *
 * Shared utility for building request headers for outbound connections.
 * Handles configuration token issuance and OAuth token refresh.
 */

import { extractConnectionPermissions } from "@/auth/configuration-scopes";
import { issueMeshToken } from "@/auth/jwt";
import type { MeshContext } from "@/core/mesh-context";
import { SpanStatusCode } from "@opentelemetry/api";
import { refreshAccessToken } from "@/oauth/token-refresh";
import { resolveOriginTokenEndpoint } from "@/oauth/resolve-token-endpoint";
import { DownstreamTokenStorage } from "@/storage/downstream-token";
import type { ConnectionEntity } from "@/tools/connection/schema";

/**
 * Strip `__binding` from configuration state values before embedding in JWTs.
 * `__binding` contains tool schemas used only by the UI for connection filtering —
 * it can be very large and causes 431 (header too large) errors when included.
 */
function stripBindingMetadata(
  state: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!state) return undefined;
  const cleaned: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(state)) {
    if (
      val &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      "__binding" in val
    ) {
      const { __binding, ...rest } = val as Record<string, unknown>;
      cleaned[key] = rest;
    } else {
      cleaned[key] = val;
    }
  }
  return cleaned;
}

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
  return ctx.tracer.startActiveSpan(
    "mesh.connection.build_headers",
    { attributes: { "connection.id": connection.id } },
    async (span) => {
      try {
        const result = await _buildRequestHeaders(connection, ctx, superUser);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error).message,
        });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

async function _buildRequestHeaders(
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

  const ctxUser = ctx.auth.user;
  const userId =
    ctxUser?.id ??
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
        user: {
          id: userId,
          email: ctxUser?.email,
          name: ctxUser?.name,
          image: ctxUser?.image,
          role: ctxUser?.role,
        },
        metadata: {
          state: stripBindingMetadata(
            connection.configuration_state as Record<string, unknown> | null,
          ),
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
        // If tokenEndpoint is a proxy URL, resolve the origin's actual endpoint
        // to avoid a self-referential call through the proxy during refresh
        let tokenEndpointForRefresh = cachedToken.tokenEndpoint;
        if (
          connection.connection_url &&
          cachedToken.tokenEndpoint?.includes("/oauth-proxy/")
        ) {
          const originEndpoint = await resolveOriginTokenEndpoint(
            connection.connection_url,
          );
          if (originEndpoint) {
            tokenEndpointForRefresh = originEndpoint;
          }
        }

        const refreshResult = await refreshAccessToken({
          ...cachedToken,
          tokenEndpoint: tokenEndpointForRefresh,
        });

        if (refreshResult.success && refreshResult.accessToken) {
          // Save refreshed token (with resolved origin endpoint for future refreshes)
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
            tokenEndpoint: tokenEndpointForRefresh,
          });

          accessToken = refreshResult.accessToken;
        } else {
          // Only delete on a definitive `400 invalid_grant`. Transient
          // failures (5xx, network, non-spec status codes) leave the cached
          // row intact so the next request retries instead of forcing a
          // manual reconnect.
          if (refreshResult.permanent === true) {
            await tokenStorage.delete(connectionId);
          }
          console.error("[Proxy] token refresh failed", {
            connectionId,
            status: refreshResult.status,
            errorCode: refreshResult.errorCode,
            permanent: refreshResult.permanent === true,
            deleted: refreshResult.permanent === true,
          });
        }
      } else {
        // Token expired but no refresh capability - delete it
        await tokenStorage.delete(connectionId);
        console.warn(
          `[Proxy] Token expired for ${connectionId} with no refresh capability ` +
            `(refreshToken: ${!!cachedToken.refreshToken}, tokenEndpoint: ${!!cachedToken.tokenEndpoint})`,
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
