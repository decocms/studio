/**
 * Request Header Builder
 *
 * Shared utility for building request headers for outbound connections.
 * Handles configuration token issuance and OAuth token refresh.
 */

import { extractConnectionPermissions } from "@/auth/configuration-scopes";
import { issueStudioToken } from "@/auth/jwt";
import type { StudioContext } from "@/core/studio-context";
import { SpanStatusCode } from "@opentelemetry/api";
import { getValidDownstreamAccessToken } from "@/oauth/token-refresh";
import { DownstreamTokenStorage } from "@/storage/downstream-token";
import { ensureRepoScopedToken } from "@/oauth/github-mint";
import { getRepoScope } from "@decocms/shared/github-repo-scope";
import type { ConnectionEntity } from "@/tools/connection/schema";
import { writeStudioHeader } from "@/core/studio-headers";

/**
 * Strip `__binding` from configuration state values before embedding in JWTs.
 * `__binding` contains tool schemas used only by the UI for connection filtering —
 * it can be very large and causes 431 (header too large) errors when included.
 *
 * Recurses into arrays and nested objects: a downstream MCP's config schema is
 * arbitrary (Studio doesn't control it), so a binding field can legitimately sit
 * inside a multi-value array or a grouped/nested object, not just at the top level.
 */
export function stripBindingMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripBindingMetadata);
  }
  if (value && typeof value === "object") {
    const { __binding, ...rest } = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(rest)) {
      cleaned[key] = stripBindingMetadata(val);
    }
    return cleaned;
  }
  return value;
}

// Common HTTP servers/proxies reject a single header line above ~8-16KB.
const MAX_HEADER_VALUE_BYTES = 8 * 1024;

/** HTTP header values must be ByteStrings (code points 0-255) with no CR/LF —
 *  `fetch`/undici throws on either violation instead of encoding/stripping it.
 *  Run metadata can carry arbitrary webhook-supplied text (e.g. non-Latin issue
 *  titles) and custom connection headers are org-configured free text (e.g.
 *  pasted with a trailing newline), so this must be checked before the value
 *  is ever handed to a request's headers — otherwise one bad value throws and
 *  fails the whole outbound request instead of just being dropped. */
function isHeaderSafe(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 255 || code === 13 || code === 10) return false;
  }
  return true;
}

/**
 * Serialize run metadata for the outbound run-metadata header, dropping it
 * (rather than truncating, which would produce invalid JSON) when it's too
 * large, or unsafe, to forward as a header.
 */
export function serializeRunMetadataHeader(
  runMetadata: Record<string, string> | undefined,
): string | null {
  if (!runMetadata || Object.keys(runMetadata).length === 0) return null;
  const serialized = JSON.stringify(runMetadata);
  // Cap is in bytes, not UTF-16 code units, so measure the encoded size.
  const byteLength = new TextEncoder().encode(serialized).length;
  if (byteLength > MAX_HEADER_VALUE_BYTES) return null;
  return isHeaderSafe(serialized) ? serialized : null;
}

/**
 * Drop any org-configured custom connection header whose key or value is
 * unsafe (outside the HTTP header ByteString range, or containing a raw
 * CR/LF) or oversized — unlike `configuration_state`/`metadata`,
 * `connection_headers.headers` has no schema-level size or byte-range check,
 * but flows straight into every outbound request's headers, where an unsafe
 * key or value throws in `fetch`/undici and an oversized value gets the
 * request rejected with 431 by the downstream server/proxy.
 */
export function sanitizeCustomHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const byteLength = new TextEncoder().encode(value).length;
    if (
      !isHeaderSafe(key) ||
      byteLength > MAX_HEADER_VALUE_BYTES ||
      !isHeaderSafe(value)
    ) {
      console.warn(
        `[Proxy] Dropping unsafe or oversized custom header "${key}"`,
      );
      continue;
    }
    safe[key] = value;
  }
  return safe;
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
    ? await issueStudioToken({
        sub: userId,
        user: {
          id: userId,
          email: ctxUser?.email,
          name: ctxUser?.name,
          role: ctxUser?.role,
        },
        metadata: {
          state: connection.configuration_state
            ? (stripBindingMetadata(connection.configuration_state) as Record<
                string,
                unknown
              >)
            : undefined,
          studioUrl: ctx.baseUrl,
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
    console.error("Failed to issue configuration token:", error);
  }

  const callerConnectionId = ctx.auth.user?.connectionId;
  const headers: Record<string, string> = {
    ...(callerConnectionId ? { "x-caller-id": callerConnectionId } : {}),
    ...(ctx.metadata.wellKnownForwardableHeaders ?? {}),
    "x-request-id": ctx.metadata.requestId,
  };

  // Forward per-run metadata (e.g. from a webhook trigger) so a downstream MCP
  // server can read run-scoped context from the request instead of a tool arg.
  const runMetadataHeader = serializeRunMetadataHeader(
    ctx.metadata.runMetadata,
  );
  if (runMetadataHeader) {
    writeStudioHeader(headers, "runMetadata", runMetadataHeader);
  } else if (
    ctx.metadata.runMetadata &&
    Object.keys(ctx.metadata.runMetadata).length > 0
  ) {
    console.warn(
      `[Proxy] runMetadata for connection ${connectionId} exceeds ${MAX_HEADER_VALUE_BYTES} bytes, dropping header`,
    );
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
    writeStudioHeader(headers, "token", configurationToken);
  }

  return headers;
}
