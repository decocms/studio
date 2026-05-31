/**
 * Pure transforms for the OAuth proxy.
 *
 * Everything here is data-in / data-out: no fetch, no storage, no Hono. The
 * OAuth proxy's genuinely tricky parts — RFC 9728 / RFC 8414 / OIDC well-known
 * URL-format probing order, rewriting an origin's metadata to point back at our
 * proxy, synthesizing metadata for servers that don't implement RFC 9728, and
 * classifying auth challenges — all live here so they can be unit-tested
 * without mocking `fetch` or the connection store.
 *
 * The handlers in `oauth-proxy.ts` wire these to real origin fetches and the
 * connection lookup; that fetch orchestration is covered by e2e against a real
 * origin server, not by faking `fetch`.
 */

/**
 * HTTP statuses that mean "no metadata at this path, but the server might
 * support OAuth elsewhere" — they drive the well-known URL-format fallback.
 * - 404: path not found (most common)
 * - 401: some servers return this for metadata endpoints
 * - 406: Grain returns this when MCP endpoints don't support .well-known paths
 */
export const NO_METADATA_STATUSES = [404, 401, 406];

/**
 * URL prefix for OAuth-related URLs based on org slug.
 * - With slug: `/api/${slug}` (org-scoped path shape)
 * - Without slug: `` (legacy shape — `/mcp/...` / `/oauth-proxy/...` at root)
 */
export function buildPathPrefix(orgSlug: string | undefined): string {
  return orgSlug ? `/api/${orgSlug}` : "";
}

/**
 * The RFC 9728 protected-resource-metadata well-known URLs to probe, in order:
 *   1. `{resource}/.well-known/oauth-protected-resource` (resource-relative)
 *   2. `/.well-known/oauth-protected-resource{resource-path}` (well-known
 *      prefix — Smithery-style)
 *   3. `/.well-known/oauth-protected-resource` (root)
 * Per RFC 9728 the resource path's trailing slash is stripped first.
 */
export function protectedResourceMetadataUrls(connectionUrl: string): string[] {
  const connUrl = new URL(connectionUrl);
  let resourcePath = connUrl.pathname;
  if (resourcePath.endsWith("/")) {
    resourcePath = resourcePath.slice(0, -1);
  }

  const withPathname = (pathname: string): string => {
    const u = new URL(connectionUrl);
    u.pathname = pathname;
    return u.toString();
  };

  return [
    withPathname(`${resourcePath}/.well-known/oauth-protected-resource`),
    withPathname(`/.well-known/oauth-protected-resource${resourcePath}`),
    withPathname(`/.well-known/oauth-protected-resource`),
  ];
}

/**
 * The authorization-server-metadata well-known URLs to probe, in order.
 *
 * With a path component (e.g. `https://auth.example.com/tenant1`):
 *   1. OAuth 2.0 with path insertion:
 *      `/.well-known/oauth-authorization-server/tenant1`
 *   2. OIDC with path insertion: `/.well-known/openid-configuration/tenant1`
 *   3. OIDC with path append: `/tenant1/.well-known/openid-configuration`
 * Without a path component:
 *   1. `/.well-known/oauth-authorization-server`
 *   2. `/.well-known/openid-configuration`
 */
export function authorizationServerMetadataUrls(
  authServerUrl: string,
): string[] {
  const url = new URL(authServerUrl);
  let authServerPath = url.pathname;
  if (authServerPath.endsWith("/")) {
    authServerPath = authServerPath.slice(0, -1);
  }
  const hasPath = authServerPath !== "" && authServerPath !== "/";

  const withPathname = (pathname: string): string => {
    const u = new URL(authServerUrl);
    u.pathname = pathname;
    return u.toString();
  };

  if (hasPath) {
    return [
      withPathname(`/.well-known/oauth-authorization-server${authServerPath}`),
      withPathname(`/.well-known/openid-configuration${authServerPath}`),
      withPathname(`${authServerPath}/.well-known/openid-configuration`),
    ];
  }
  return [
    withPathname("/.well-known/oauth-authorization-server"),
    withPathname("/.well-known/openid-configuration"),
  ];
}

/**
 * True when `data` is RFC 8414 Authorization Server Metadata rather than RFC
 * 9728 Protected Resource Metadata. Some servers (ClickHouse) incorrectly
 * return AS metadata at the protected-resource endpoint: it carries `issuer`
 * and endpoint URLs but no `resource`.
 */
export function isAuthServerMetadata(data: Record<string, unknown>): boolean {
  return (
    "issuer" in data &&
    !("resource" in data) &&
    ("authorization_endpoint" in data || "token_endpoint" in data)
  );
}

/**
 * Whether a `WWW-Authenticate` value is a *meaningful* OAuth challenge. MCP
 * OAuth uses RFC 9728 `resource_metadata=` (strong signal); we also accept
 * standard OAuth error hints for servers that don't implement RFC 9728.
 */
export function looksLikeOAuthWwwAuthenticate(wwwAuth: string): boolean {
  const lower = wwwAuth.toLowerCase();
  return (
    lower.includes("resource_metadata=") ||
    lower.includes("invalid_token") ||
    lower.includes("oauth")
  );
}

/** Classify a downstream connection error as a 401-style auth error. */
export function isAuthError(error: {
  message?: string;
  status?: number;
  code?: number;
}): boolean {
  const message = error.message?.toLowerCase() ?? "";
  return (
    error.status === 401 ||
    error.code === 401 ||
    (error.message?.includes("401") ?? false) ||
    message.includes("unauthorized") ||
    message.includes("invalid_token") ||
    message.includes("api key required") ||
    message.includes("api-key required")
  );
}

export interface ProxyMetadataUrls {
  /** `…/mcp/:connectionId` on our proxy (the `resource` value). */
  proxyResourceUrl: string;
  /** `…/oauth-proxy/:connectionId` on our proxy (the `authorization_servers` value). */
  proxyAuthServer: string;
}

/**
 * Rewrite an origin's protected-resource metadata so `resource` and
 * `authorization_servers` point at our proxy, preserving every other field.
 */
export function rewriteProtectedResourceMetadata(
  originData: Record<string, unknown>,
  { proxyResourceUrl, proxyAuthServer }: ProxyMetadataUrls,
): Record<string, unknown> {
  return {
    ...originData,
    resource: proxyResourceUrl,
    authorization_servers: [proxyAuthServer],
  };
}

/**
 * Clean synthetic protected-resource metadata pointing at our proxy, for
 * servers that support OAuth but don't expose RFC 9728 metadata (or that
 * returned AS metadata at the PR endpoint). We deliberately don't spread the
 * origin fields, to avoid confusing MCP SDK clients with unexpected keys.
 */
export function syntheticProtectedResourceMetadata({
  proxyResourceUrl,
  proxyAuthServer,
  scopesSupported = ["*"],
}: ProxyMetadataUrls & {
  scopesSupported?: unknown[];
}): Record<string, unknown> {
  return {
    resource: proxyResourceUrl,
    authorization_servers: [proxyAuthServer],
    bearer_methods_supported: ["header"],
    scopes_supported: scopesSupported,
  };
}

/** Honor non-empty origin `scopes_supported`, else fall back to `["*"]`. */
export function scopesFromOrigin(data: Record<string, unknown>): unknown[] {
  return "scopes_supported" in data &&
    Array.isArray(data.scopes_supported) &&
    data.scopes_supported.length > 0
    ? (data.scopes_supported as unknown[])
    : ["*"];
}

/**
 * Rewrite an origin auth server's endpoint URLs (authorize/token/register) to
 * route through our proxy, preserving every other field. Endpoints absent on
 * the origin stay absent (`undefined`).
 */
export function rewriteAuthServerMetadata(
  originData: Record<string, unknown>,
  proxyBase: string,
): Record<string, unknown> {
  return {
    ...originData,
    authorization_endpoint: originData.authorization_endpoint
      ? `${proxyBase}/authorize`
      : undefined,
    token_endpoint: originData.token_endpoint
      ? `${proxyBase}/token`
      : undefined,
    registration_endpoint: originData.registration_endpoint
      ? `${proxyBase}/register`
      : undefined,
  };
}

/**
 * The `WWW-Authenticate` challenge we return when the origin supports OAuth:
 * advertises our proxy's `resource_metadata` discovery URL.
 */
export function resourceMetadataChallenge({
  origin,
  prefix,
  connectionId,
}: {
  origin: string;
  prefix: string;
  connectionId: string;
}): string {
  return `Bearer realm="mcp",resource_metadata="${origin}${prefix}/mcp/${connectionId}/.well-known/oauth-protected-resource"`;
}
