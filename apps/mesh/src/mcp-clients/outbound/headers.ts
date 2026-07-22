/**
 * Request Header Builder
 *
 * Shared utility for building request headers for outbound connections.
 * Handles configuration token issuance and OAuth token refresh.
 */

import { extractConnectionPermissions } from "@/auth/configuration-scopes";
import { issueMeshToken } from "@/auth/jwt";
import type { StudioContext } from "@/core/studio-context";
import { SpanStatusCode } from "@opentelemetry/api";
import { getValidDownstreamAccessToken } from "@/oauth/token-refresh";
import { DownstreamTokenStorage } from "@/storage/downstream-token";
import { ensureRepoScopedToken } from "@/oauth/github-mint";
import { getRepoScope } from "@/shared/github-repo-scope";
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
 * @param ctx - Studio context
 * @param superUser - Whether to use superuser mode for background processes
 * @returns Headers object ready to be used in HTTP requests
 */
export async function buildRequestHeaders(
  connection: ConnectionEntity,
  ctx: StudioContext,
  superUser: boolean,
): Promise<Record<string, string>> {
  return ctx.tracer.startActiveSpan(
    "studio.connection.build_headers",
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
  ctx: StudioContext,
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

  // Forward per-run metadata (e.g. from a webhook trigger) so a downstream MCP
  // server can read run-scoped context from the request instead of a tool arg.
  if (
    ctx.metadata.runMetadata &&
    Object.keys(ctx.metadata.runMetadata).length > 0
  ) {
    headers["x-mesh-run-metadata"] = JSON.stringify(ctx.metadata.runMetadata);
  }

  // Try to get cached token from downstream_tokens first
  // This supports OAuth token refresh for connections that use OAuth
  let accessToken: string | null = null;

  const repoScope = getRepoScope(connection);
  const useLegacyRepoMint = !!repoScope?.sourceConnectionId;

  if (useLegacyRepoMint) {
    try {
      accessToken = await ensureRepoScopedToken(ctx, connection);
    } catch (err) {
      console.error("[Proxy] repo-scoped legacy token mint failed", {
        connectionId,
        error: (err as Error).message,
      });
    }
  } else {
    const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
    const tokenResult = await getValidDownstreamAccessToken({
      connectionId,
      connectionUrl: connection.connection_url,
      tokenStorage,
    });

    if (tokenResult.accessToken) {
      accessToken = tokenResult.accessToken;
    } else if (tokenResult.state === "expired_without_refresh") {
      console.warn(
        `[Proxy] Token expired for ${connectionId} with no refresh capability`,
      );
    }
    // `refresh_failed` is already logged (once per backoff window) by the
    // refresh primitive with full detail; the proxy falls back to the
    // connection token below, so no second log here.
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
